// Command timeline-gmessages is the Google Messages sidecar for Timeline's
// google-messages sync source. It wraps Beeper's libgm (the reverse-engineered
// Google Messages for Web protocol): Timeline runs `dump` as a one-shot
// subprocess and imports the JSONL it prints (src/platforms/google-messages).
//
// It never sends messages or mutates anything on the account: it lists
// conversations, pages message history, lists contacts, and optionally
// downloads media. Output is newline-delimited JSON (JSONL) on stdout —
// conversation records always precede their messages — while human-readable
// logs go to stderr.
//
// Subcommands:
//
//	pair    Read cookies.txt, pair with the phone (prints an emoji to confirm
//	        on the device), and write session.json.
//	dump    Load session.json, connect, and stream conversations, messages and
//	        contacts as JSONL. Flags: -since, -folder, -max-messages, -media.
//	watch   Load session.json, connect, and log events until interrupted.
//
// See README.md for pairing and the JSONL contract.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/exhttp"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

const (
	sessionFile = "session.json"
	cookiesFile = "cookies.txt"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd := os.Args[1]
	args := os.Args[2:]

	log := newLogger()

	var err error
	switch cmd {
	case "pair":
		err = runPair(log)
	case "dump":
		err = runDump(log, args)
	case "watch":
		err = runWatch(log)
	case "-h", "--help", "help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", cmd)
		usage()
		os.Exit(2)
	}
	if err != nil {
		log.Fatal().Err(err).Msg("Command failed")
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `timeline-gmessages — Google Messages sidecar for Timeline

Usage:
  timeline-gmessages pair              Pair using ./cookies.txt, write ./session.json
  timeline-gmessages dump [flags]      Stream conversations + messages as JSONL to stdout
  timeline-gmessages watch             Connect and log events until Ctrl-C

dump flags:
  -since MS         Only messages at/after this Unix-ms timestamp; skip idle conversations (default 0 = all)
  -cursors PATH     JSON {"<conversation id>": <unix ms>} overriding -since per conversation ("-" = stdin)
  -max-messages N   Stop paging each conversation after ~N messages (0 = all, default 0)
  -media DIR        Download message media into DIR (default: skip media)
  -folder inbox|archive|spam|all   Which folders to dump (default all, including spam & blocked)

Files (in the working directory):
  cookies.txt   INPUT for pair: paste of devtools "Copy as cURL" (or Cookie header, or JSON)
  session.json   Session state written by pair, read by dump/watch (secret — gitignored)
`)
}

// newLogger defaults to info level: libgm logs full decrypted response
// payloads (real message content) at debug. Set GMESSAGES_DEBUG=1 to opt in.
func newLogger() zerolog.Logger {
	level := zerolog.InfoLevel
	if os.Getenv("GMESSAGES_DEBUG") != "" {
		level = zerolog.DebugLevel
	}
	return zerolog.New(zerolog.NewConsoleWriter(func(w *zerolog.ConsoleWriter) {
		w.Out = os.Stderr
		w.TimeFormat = time.Stamp
	})).Level(level).With().Timestamp().Logger()
}

// ---- pair -----------------------------------------------------------------

func runPair(log zerolog.Logger) error {
	if _, err := os.Stat(sessionFile); err == nil {
		return fmt.Errorf("%s already exists; delete it to re-pair", sessionFile)
	}

	cookies, err := readCookies(cookiesFile)
	if err != nil {
		return err
	}
	sess := libgm.NewAuthData()
	sess.SetCookies(cookies)

	cli := libgm.NewClient(sess, nil, log, exhttp.SensibleClientSettings)

	var once sync.Once
	paired := make(chan struct{})
	cli.SetEventHandler(func(rawEvt any) {
		switch evt := rawEvt.(type) {
		case *events.PairSuccessful:
			log.Info().Msg("Pairing successful — writing session.json")
			if err := writeSession(sess); err != nil {
				log.Err(err).Msg("Failed to write session")
			}
			once.Do(func() { close(paired) })
		case *events.GaiaLoggedOut:
			log.Error().Msg("Logged out during pairing — cookies rejected")
		default:
			log.Debug().Type("event", evt).Msg("event")
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	log.Info().Msg("Starting pairing — confirm the matching emoji on your phone")
	err = cli.DoGaiaPairing(ctx, func(emoji string) {
		fmt.Fprintf(os.Stderr, "\n  Confirm this on your phone:  %s\n\n", emoji)
	})
	if err != nil {
		return fmt.Errorf("pairing failed: %w", err)
	}

	// DoGaiaPairing writes the session on PairSuccessful, then reconnects in the
	// background. Give the write a moment to land before exiting.
	select {
	case <-paired:
	case <-time.After(10 * time.Second):
		log.Warn().Msg("Did not observe PairSuccessful; session may be incomplete")
	}
	cli.Disconnect()
	return nil
}

// ---- dump -----------------------------------------------------------------

func runDump(log zerolog.Logger, args []string) error {
	fs := flag.NewFlagSet("dump", flag.ContinueOnError)
	maxMessages := fs.Int("max-messages", 0, "stop paging each conversation after ~N messages (0 = all)")
	mediaDir := fs.String("media", "", "download media into this directory (default: skip)")
	folderArg := fs.String("folder", "all", "inbox|archive|spam|all")
	sinceMs := fs.Int64("since", 0, "only emit messages at/after this Unix-ms timestamp; skip conversations idle before it (0 = everything)")
	cursorsPath := fs.String("cursors", "", "JSON object of conversation id -> Unix-ms cursor, overriding -since per conversation (\"-\" = stdin)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	folders, err := parseFolders(*folderArg)
	if err != nil {
		return err
	}
	cursors, err := readCursors(*cursorsPath)
	if err != nil {
		return err
	}
	if *mediaDir != "" {
		if err := os.MkdirAll(*mediaDir, 0o700); err != nil {
			return err
		}
	}

	ctx := context.Background()
	cli, sess, err := connectFromSession(ctx, log)
	if err != nil {
		return err
	}
	defer func() {
		cli.Disconnect()
		_ = writeSession(sess) // persist refreshed tokens/cookies
	}()

	enc := json.NewEncoder(os.Stdout)

	// Contacts first — cheap, and useful for mapping participant IDs to names.
	if contacts, err := cli.ListContacts(ctx); err != nil {
		log.Warn().Err(err).Msg("ListContacts failed")
	} else {
		for _, c := range contacts.GetContacts() {
			_ = enc.Encode(contactRecord(c))
		}
		log.Info().Int("count", len(contacts.GetContacts())).Msg("Dumped contacts")
	}

	seen := map[string]bool{}
	var totalConvs, totalMsgs, idleConvs, failedConvs int
	for _, folder := range folders {
		conversations, err := listAllConversations(ctx, log, cli, folder)
		if err != nil {
			return fmt.Errorf("list conversations (%v): %w", folder, err)
		}

		for _, conv := range conversations {
			convID := conv.GetConversationID()
			if seen[convID] {
				continue
			}
			seen[convID] = true
			since := *sinceMs
			if c, ok := cursors[convID]; ok {
				since = c
			}
			if since > 0 && conv.GetLastMessageTimestamp() > 0 && toMillis(conv.GetLastMessageTimestamp()) < since {
				idleConvs++
				continue
			}
			totalConvs++

			_ = enc.Encode(conversationRecord(conv, folder))

			n, err := dumpMessages(ctx, log, cli, enc, convID, *maxMessages, since, *mediaDir)
			totalMsgs += n
			if err != nil {
				// The consumer must not advance this conversation's cursor:
				// pages older than the failure were never fetched.
				failedConvs++
				log.Warn().Err(err).Str("conversation", convID).Msg("Failed to fully page conversation")
				_ = enc.Encode(conversationErrorT{Kind: "conversation_error", ID: convID, Error: err.Error()})
				continue
			}
			_ = enc.Encode(conversationDoneT{Kind: "conversation_done", ID: convID, Messages: n})
			log.Info().Str("conversation", convID).Str("name", conv.GetName()).Int("messages", n).Msg("Dumped conversation")
		}
	}
	log.Info().Int("conversations", totalConvs).Int("idle_skipped", idleConvs).Int("failed", failedConvs).Int("messages", totalMsgs).Msg("Dump complete")
	return nil
}

// listAllConversations follows the phone's conversation-list cursor to the
// end. The phone returns ~250 conversations per page regardless of the
// requested count; a single page silently drops the rest.
func listAllConversations(ctx context.Context, log zerolog.Logger, cli *libgm.Client, folder gmproto.ListConversationsRequest_Folder) ([]*gmproto.Conversation, error) {
	const pageSize = 1000
	var all []*gmproto.Conversation
	var cursor *gmproto.Cursor
	for page := 1; ; page++ {
		resp, err := cli.ListConversations(ctx, &gmproto.ListConversationsRequest{
			Count:  pageSize,
			Folder: folder,
			Cursor: cursor,
		})
		if err != nil {
			return all, err
		}
		all = append(all, resp.GetConversations()...)
		next := resp.GetCursor()
		if len(resp.GetConversations()) == 0 || next == nil || next.GetLastItemID() == "" {
			log.Info().Str("folder", folder.String()).Int("pages", page).Int("count", len(all)).Msg("Listed conversations")
			return all, nil
		}
		cursor = next
	}
}

// readCursors loads the per-conversation cursor map ("-" = stdin, "" = none).
func readCursors(path string) (map[string]int64, error) {
	cursors := map[string]int64{}
	if path == "" {
		return cursors, nil
	}
	var r io.Reader = os.Stdin
	if path != "-" {
		f, err := os.Open(path)
		if err != nil {
			return nil, fmt.Errorf("open cursors: %w", err)
		}
		defer f.Close()
		r = f
	}
	if err := json.NewDecoder(r).Decode(&cursors); err != nil {
		return nil, fmt.Errorf("parse cursors: %w", err)
	}
	return cursors, nil
}

// fetchPage retries transient request failures (phone-proxied requests drop
// occasionally) before giving up on a page.
func fetchPage(ctx context.Context, log zerolog.Logger, cli *libgm.Client, convID string, pageSize int64, cursor *gmproto.Cursor) (*gmproto.ListMessagesResponse, error) {
	const attempts = 3
	var err error
	for attempt := 1; attempt <= attempts; attempt++ {
		var resp *gmproto.ListMessagesResponse
		resp, err = cli.FetchMessages(ctx, convID, pageSize, cursor)
		if err == nil {
			return resp, nil
		}
		if attempt < attempts {
			delay := time.Duration(attempt*attempt) * 2 * time.Second
			log.Warn().Err(err).Str("conversation", convID).Int("attempt", attempt).Dur("retry_in", delay).Msg("FetchMessages failed, retrying")
			time.Sleep(delay)
		}
	}
	return nil, err
}

// dumpMessages pages one conversation from newest to oldest following the
// response cursor, emitting one JSONL record per message at/after sinceMs
// (0 = no bound). It returns the number of messages emitted.
func dumpMessages(ctx context.Context, log zerolog.Logger, cli *libgm.Client, enc *json.Encoder, convID string, maxMessages int, sinceMs int64, mediaDir string) (int, error) {
	const pageSize = 100
	var cursor *gmproto.Cursor
	var count int
	for {
		resp, err := fetchPage(ctx, log, cli, convID, pageSize, cursor)
		if err != nil {
			return count, err
		}
		msgs := resp.GetMessages()
		if len(msgs) == 0 {
			return count, nil
		}
		reachedSince := false
		for _, msg := range msgs {
			if sinceMs > 0 && toMillis(msg.GetTimestamp()) < sinceMs {
				reachedSince = true
				continue
			}
			rec := messageRecord(msg)
			if mediaDir != "" {
				rec.Media = downloadMedia(log, cli, mediaDir, msg)
			}
			_ = enc.Encode(rec)
			count++
		}
		if reachedSince || (maxMessages > 0 && count >= maxMessages) {
			return count, nil
		}
		next := resp.GetCursor()
		if next == nil || next.GetLastItemID() == "" {
			return count, nil
		}
		cursor = next
	}
}

// downloadMedia downloads any attachment parts of a message into mediaDir and
// returns their metadata. Google stores a thumbnail beside every attachment,
// under its own media ID and key; when the phone unlocks only that one, it is
// downloaded instead so the part is not lost entirely. The record's status says
// which copy landed on disk.
func downloadMedia(log zerolog.Logger, cli *libgm.Client, mediaDir string, msg *gmproto.Message) []mediaRecord {
	var out []mediaRecord
	for _, part := range msg.GetMessageInfo() {
		mc, ok := part.GetData().(*gmproto.MessageInfo_MediaContent)
		if !ok {
			continue
		}
		media := mc.MediaContent
		rec := mediaRecord{
			MediaID:  media.GetMediaID(),
			Name:     media.GetMediaName(),
			MimeType: media.GetMimeType(),
			Format:   media.GetFormat().String(),
			Size:     media.GetSize(),
			Width:    media.GetDimensions().GetWidth(),
			Height:   media.GetDimensions().GetHeight(),
		}
		id, key := media.GetMediaID(), media.GetDecryptionKey()
		status := "stored"
		if id == "" || len(key) == 0 {
			id, key = media.GetThumbnailMediaID(), media.GetThumbnailDecryptionKey()
			status = "thumbnail"
		}
		if id == "" || len(key) == 0 {
			rec.Status = "unavailable"
			out = append(out, rec)
			continue
		}
		path := filepath.Join(mediaDir, mediaFileName(id, media.GetMediaName()))
		size, err := downloadMediaFile(cli, id, key, path)
		if err != nil {
			log.Warn().Err(err).Str("media_id", id).Str("copy", status).Str("path", path).Msg("Media download failed")
			rec.Status = "failed"
		} else {
			rec.Status = status
			rec.Path = path
			rec.Size = size
		}
		out = append(out, rec)
	}
	return out
}

// mediaFileName names a staged download after the media ID it came from, which
// can contain "/" — flatten so everything lands directly in mediaDir.
func mediaFileName(mediaID, mediaName string) string {
	name := strings.ReplaceAll(mediaID, "/", "_")
	if mediaName != "" {
		name += "-" + filepath.Base(mediaName)
	}
	return name
}

// downloadMediaFile streams one decrypted attachment to path and returns the
// number of bytes written.
func downloadMediaFile(cli *libgm.Client, mediaID string, key []byte, path string) (int64, error) {
	body, err := cli.DownloadMedia(mediaID, key)
	if err != nil {
		return 0, err
	}
	defer body.Close()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, err
	}
	size, err := io.Copy(f, body)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	return size, err
}

// ---- watch ----------------------------------------------------------------

func runWatch(log zerolog.Logger) error {
	cli, sess, err := connectFromSession(context.Background(), log)
	if err != nil {
		return err
	}
	defer func() {
		cli.Disconnect()
		_ = writeSession(sess)
	}()

	log.Info().Msg("Watching for events — Ctrl-C to stop")
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	start := time.Now()
	for {
		select {
		case <-c:
			log.Info().Str("uptime", time.Since(start).Round(time.Second).String()).Msg("Interrupt — exiting")
			return nil
		case <-ticker.C:
			log.Info().
				Str("uptime", time.Since(start).Round(time.Second).String()).
				Bool("connected", cli.IsConnected()).
				Msg("Still watching")
		}
	}
}

// ---- shared connect + event handling --------------------------------------

// connectFromSession loads session.json, connects, and blocks until the client
// is usable (or logs out / times out). The returned AuthData is the live
// session and should be re-persisted on exit to keep refreshed tokens.
//
// Readiness: libgm never emits ClientReady (stale event type); the working
// signal is the BROWSER_ACTIVE alert (events.BrowserActive). If it doesn't
// arrive, retry SetActiveSession like the bridge's hackyResetActive, then fall
// back to probing with a real request.
func connectFromSession(ctx context.Context, log zerolog.Logger) (*libgm.Client, *libgm.AuthData, error) {
	sess, err := readSession(sessionFile)
	if err != nil {
		return nil, nil, err
	}
	cli := libgm.NewClient(sess, nil, log, exhttp.SensibleClientSettings)

	ready := make(chan struct{})
	loggedOut := make(chan struct{})
	var readyOnce, logoutOnce sync.Once
	cli.SetEventHandler(func(rawEvt any) {
		switch evt := rawEvt.(type) {
		case *events.BrowserActive:
			log.Info().Msg("Browser active — session is live")
			readyOnce.Do(func() { close(ready) })
		case *events.AuthTokenRefreshed:
			log.Debug().Msg("Auth token refreshed")
		case *events.GaiaLoggedOut:
			log.Error().Msg("Session logged out — re-pair required")
			logoutOnce.Do(func() { close(loggedOut) })
		case *events.PhoneNotResponding:
			log.Warn().Msg("Phone not responding (is it online?)")
		case *events.PhoneRespondingAgain:
			log.Info().Msg("Phone responding again")
		case *events.ListenFatalError:
			log.Error().Err(evt.Error).Msg("Fatal listen error")
		case *events.ListenTemporaryError:
			log.Warn().Err(evt.Error).Msg("Temporary listen error")
		case *gmproto.Message:
			log.Info().Str("conversation", evt.GetConversationID()).Str("message", evt.GetMessageID()).Msg("Incoming message event")
		case *gmproto.Conversation:
			log.Debug().Str("conversation", evt.GetConversationID()).Msg("Conversation event")
		default:
			log.Debug().Type("event", evt).Msg("event")
		}
	})

	if err := cli.Connect(ctx); err != nil {
		return nil, nil, fmt.Errorf("connect: %w", err)
	}

	// BrowserActive usually never arrives for a fresh connection, so give it a
	// short grace period and then confirm the session with a real request,
	// re-setting the active session between attempts like the bridge does.
	var probeErr error
	for attempt := 1; attempt <= 3; attempt++ {
		select {
		case <-ready:
			return cli, sess, nil
		case <-loggedOut:
			cli.Disconnect()
			return nil, nil, errors.New("session logged out — delete session.json and re-pair")
		case <-time.After(5 * time.Second):
		}
		if _, probeErr = cli.ListContacts(ctx); probeErr == nil {
			log.Info().Int("attempt", attempt).Msg("Session probe succeeded")
			return cli, sess, nil
		}
		log.Warn().Err(probeErr).Int("attempt", attempt).Msg("Session probe failed, re-setting active session")
		if err := cli.SetActiveSession(ctx); err != nil {
			log.Warn().Err(err).Msg("SetActiveSession failed")
		}
	}
	cli.Disconnect()
	return nil, nil, fmt.Errorf("session unusable (is the phone online?): %w", probeErr)
}

// ---- JSONL record shapes --------------------------------------------------
//
// The contract consumed by src/platforms/google-messages/parser.ts.

// Google timestamps are microseconds; the JSONL carries milliseconds.
func toMillis(micros int64) int64 { return micros / 1000 }

type conversationRecordT struct {
	Kind         string              `json:"kind"` // "conversation"
	ID           string              `json:"id"`
	Name         string              `json:"name,omitempty"`
	Folder       string              `json:"folder"`
	IsGroup      bool                `json:"is_group"`
	Type         string              `json:"type"` // SMS / RCS / ...
	Participants []participantRecord `json:"participants"`
	LastTS       int64               `json:"last_message_ts_ms,omitempty"`
}

// Emitted after a conversation's pages are exhausted; the consumer may
// advance that conversation's cursor.
type conversationDoneT struct {
	Kind     string `json:"kind"` // "conversation_done"
	ID       string `json:"id"`
	Messages int    `json:"messages"`
}

// Emitted when a conversation could not be fully paged even after retries.
type conversationErrorT struct {
	Kind  string `json:"kind"` // "conversation_error"
	ID    string `json:"id"`
	Error string `json:"error"`
}

type participantRecord struct {
	ParticipantID string `json:"participant_id"`
	Number        string `json:"number,omitempty"`
	Name          string `json:"name,omitempty"`
	IsMe          bool   `json:"is_me"`
	// Conversations list stale/alternate identities for the same number as
	// invisible participants alongside the visible one.
	Visible bool `json:"visible"`
}

type messageRecordT struct {
	Kind           string        `json:"kind"` // "message"
	ID             string        `json:"id"`
	ConversationID string        `json:"conversation_id"`
	TimestampMS    int64         `json:"timestamp_ms"`
	Direction      string        `json:"direction"` // incoming | outgoing | system | unknown
	Status         string        `json:"status,omitempty"`
	MessageType    string        `json:"message_type"`
	SenderID       string        `json:"sender_participant_id,omitempty"`
	SenderNumber   string        `json:"sender_number,omitempty"`
	SenderName     string        `json:"sender_name,omitempty"`
	Text           string        `json:"text,omitempty"`
	Subject        string        `json:"subject,omitempty"`
	ReplyTo        string        `json:"reply_to,omitempty"`
	Reactions      []string      `json:"reactions,omitempty"`
	Media          []mediaRecord `json:"media,omitempty"`
}

type mediaRecord struct {
	MediaID  string `json:"media_id"`
	Name     string `json:"name,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
	Format   string `json:"format,omitempty"`
	// Bytes written once a copy is on disk, otherwise the size the phone declared.
	Size int64 `json:"size,omitempty"`
	// Dimensions of the full-size image as the phone declared them, whichever copy was downloaded.
	Width  int64  `json:"width,omitempty"`
	Height int64  `json:"height,omitempty"`
	Status string `json:"status,omitempty"` // stored | thumbnail | failed | unavailable
	Path   string `json:"path,omitempty"`
}

type contactRecordT struct {
	Kind      string `json:"kind"` // "contact"
	ID        string `json:"participant_id"`
	ContactID string `json:"contact_id,omitempty"`
	Name      string `json:"name,omitempty"`
	Number    string `json:"number,omitempty"`
}

func conversationRecord(c *gmproto.Conversation, folder gmproto.ListConversationsRequest_Folder) conversationRecordT {
	parts := make([]participantRecord, 0, len(c.GetParticipants()))
	for _, p := range c.GetParticipants() {
		num := p.GetID().GetNumber()
		if num == "" {
			num = p.GetFormattedNumber()
		}
		parts = append(parts, participantRecord{
			ParticipantID: p.GetID().GetParticipantID(),
			Number:        num,
			Name:          p.GetFullName(),
			IsMe:          p.GetIsMe(),
			Visible:       p.GetIsVisible(),
		})
	}
	return conversationRecordT{
		Kind:         "conversation",
		ID:           c.GetConversationID(),
		Name:         c.GetName(),
		Folder:       folder.String(),
		IsGroup:      c.GetIsGroupChat(),
		Type:         c.GetType().String(),
		Participants: parts,
		LastTS:       toMillis(c.GetLastMessageTimestamp()),
	}
}

func messageRecord(m *gmproto.Message) messageRecordT {
	var text strings.Builder
	for _, part := range m.GetMessageInfo() {
		if mc, ok := part.GetData().(*gmproto.MessageInfo_MessageContent); ok {
			if text.Len() > 0 {
				text.WriteByte('\n')
			}
			text.WriteString(mc.MessageContent.GetContent())
		}
	}
	var reactions []string
	for _, r := range m.GetReactions() {
		reactions = append(reactions, r.GetData().GetUnicode())
	}
	sender := m.GetSenderParticipant()
	return messageRecordT{
		Kind:           "message",
		ID:             m.GetMessageID(),
		ConversationID: m.GetConversationID(),
		TimestampMS:    toMillis(m.GetTimestamp()),
		Direction:      direction(m),
		Status:         m.GetMessageStatus().GetStatus().String(),
		MessageType:    messageKind(m.GetType()),
		SenderID:       m.GetParticipantID(),
		SenderNumber:   sender.GetID().GetNumber(),
		SenderName:     sender.GetFullName(),
		Text:           text.String(),
		Subject:        m.GetSubject(),
		ReplyTo:        m.GetReplyMessage().GetMessageID(),
		Reactions:      reactions,
	}
}

func contactRecord(c *gmproto.Contact) contactRecordT {
	return contactRecordT{
		Kind:      "contact",
		ID:        c.GetParticipantID(),
		ContactID: c.GetContactID(),
		Name:      c.GetName(),
		Number:    c.GetNumber().GetNumber(),
	}
}

// direction classifies a message using its status code. Outgoing statuses are
// < 100, incoming are >= 100 (see MessageStatusType). Participant "1" is self.
func direction(m *gmproto.Message) string {
	if m.GetParticipantID() == "1" {
		return "outgoing"
	}
	status := m.GetMessageStatus().GetStatus()
	switch {
	case status == gmproto.MessageStatusType_STATUS_UNKNOWN:
		return "unknown"
	case status < 100:
		return "outgoing"
	case status >= gmproto.MessageStatusType_TOMBSTONE_PARTICIPANT_JOINED:
		// Tombstones: in-thread banners ("Texting with … (SMS/MMS)", joins,
		// renames) that the app renders as messages but nobody sent.
		return "system"
	default:
		return "incoming"
	}
}

// messageKind maps Message.Type (1=sms, 2/3=mms, 4=rcs) to a label.
func messageKind(t int64) string {
	switch t {
	case 1:
		return "sms"
	case 2, 3:
		return "mms"
	case 4:
		return "rcs"
	default:
		return fmt.Sprintf("type%d", t)
	}
}

func parseFolders(arg string) ([]gmproto.ListConversationsRequest_Folder, error) {
	switch strings.ToLower(arg) {
	case "inbox":
		return []gmproto.ListConversationsRequest_Folder{gmproto.ListConversationsRequest_INBOX}, nil
	case "archive":
		return []gmproto.ListConversationsRequest_Folder{gmproto.ListConversationsRequest_ARCHIVE}, nil
	case "spam":
		return []gmproto.ListConversationsRequest_Folder{gmproto.ListConversationsRequest_SPAM_BLOCKED}, nil
	case "all", "":
		return []gmproto.ListConversationsRequest_Folder{
			gmproto.ListConversationsRequest_INBOX,
			gmproto.ListConversationsRequest_ARCHIVE,
			gmproto.ListConversationsRequest_SPAM_BLOCKED,
		}, nil
	default:
		return nil, fmt.Errorf("invalid folder %q (want inbox|archive|spam|all)", arg)
	}
}

// ---- session/cookie persistence -------------------------------------------

func readCookies(path string) (map[string]string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%s not found — see README.md for how to extract account cookies", path)
		}
		return nil, err
	}
	cookies, err := parseCookieInput(string(content))
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	for _, required := range []string{"SID", "HSID", "SSID", "OSID", "APISID", "SAPISID"} {
		if cookies[required] == "" {
			return nil, fmt.Errorf("%s is missing required cookie %q", path, required)
		}
	}
	return cookies, nil
}

// parseCookieInput accepts any of: a JSON object of cookie name→value, a
// browser-devtools "Copy as cURL" command, or a raw Cookie header / cookie
// string ("SID=...; HSID=...").
func parseCookieInput(content string) (map[string]string, error) {
	trimmed := strings.TrimSpace(content)
	if strings.HasPrefix(trimmed, "{") {
		var cookies map[string]string
		if err := json.Unmarshal([]byte(trimmed), &cookies); err != nil {
			return nil, err
		}
		return cookies, nil
	}
	if idx := strings.Index(strings.ToLower(trimmed), "cookie:"); idx >= 0 {
		rest := trimmed[idx+len("cookie:"):]
		if q := strings.IndexAny(rest, `'"`); q >= 0 {
			rest = rest[:q]
		}
		return parseCookiePairs(rest)
	}
	if strings.Contains(trimmed, "=") {
		return parseCookiePairs(trimmed)
	}
	return nil, errors.New("unrecognized cookie input (want JSON object, curl command, or Cookie header)")
}

func parseCookiePairs(s string) (map[string]string, error) {
	cookies := map[string]string{}
	for _, pair := range strings.Split(s, ";") {
		name, value, found := strings.Cut(strings.TrimSpace(pair), "=")
		if !found || name == "" {
			continue
		}
		cookies[strings.TrimSpace(name)] = strings.TrimSpace(value)
	}
	if len(cookies) == 0 {
		return nil, errors.New("no cookie pairs found")
	}
	return cookies, nil
}

func readSession(path string) (*libgm.AuthData, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%s not found — run `timeline-gmessages pair` first", path)
		}
		return nil, err
	}
	defer f.Close()
	sess := libgm.NewAuthData()
	if err := json.NewDecoder(f).Decode(sess); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return sess, nil
}

func writeSession(sess *libgm.AuthData) error {
	f, err := os.OpenFile(sessionFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	return json.NewEncoder(f).Encode(sess)
}
