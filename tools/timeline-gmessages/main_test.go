package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

func TestParseCookieInput(t *testing.T) {
	cases := []struct {
		name  string
		input string
	}{
		{"json", `{"SID": "aaa", "HSID": "bbb"}`},
		{"curl", `curl 'https://messages.google.com/web/config' -H 'accept: text/html' -H 'cookie: SID=aaa; HSID=bbb' -H 'user-agent: x'`},
		{"curl-uppercase-double-quoted", `curl "https://messages.google.com" -H "Cookie: SID=aaa; HSID=bbb"`},
		{"raw-header", `Cookie: SID=aaa; HSID=bbb`},
		{"bare-pairs", `SID=aaa; HSID=bbb`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cookies, err := parseCookieInput(tc.input)
			if err != nil {
				t.Fatal(err)
			}
			if cookies["SID"] != "aaa" || cookies["HSID"] != "bbb" {
				t.Fatalf("unexpected cookies: %#v", cookies)
			}
		})
	}
}

func TestParseCookieInputRejectsGarbage(t *testing.T) {
	if _, err := parseCookieInput("not cookies at all"); err == nil {
		t.Fatal("expected error")
	}
}

func dated(timestampsMs ...int64) []*gmproto.Conversation {
	conversations := make([]*gmproto.Conversation, 0, len(timestampsMs))
	for _, ms := range timestampsMs {
		// The phone reports microseconds; toMillis converts them.
		conversations = append(conversations, &gmproto.Conversation{LastMessageTimestamp: ms * 1000})
	}
	return conversations
}

func TestPageOlderThan(t *testing.T) {
	cases := []struct {
		name   string
		page   []*gmproto.Conversation
		cutoff int64
		want   bool
	}{
		{"no cutoff", dated(1, 2), 0, false},
		{"all older", dated(3, 2), 5, true},
		{"one at the cutoff", dated(5, 2), 5, false},
		{"undated conversations are ignored", dated(0, 3), 5, true},
		{"a page of only undated conversations", dated(0, 0), 5, false},
		{"empty page", nil, 5, false},
	}
	for _, c := range cases {
		if got := pageOlderThan(c.page, c.cutoff); got != c.want {
			t.Errorf("%s: pageOlderThan = %v, want %v", c.name, got, c.want)
		}
	}
}

// fakeConversationList serves pages in order, failing the first failures calls.
func fakeConversationList(pages [][]*gmproto.Conversation, failures int) (func(context.Context, *gmproto.ListConversationsRequest) (*gmproto.ListConversationsResponse, error), *int) {
	calls := 0
	served := 0
	return func(_ context.Context, req *gmproto.ListConversationsRequest) (*gmproto.ListConversationsResponse, error) {
		calls++
		if failures > 0 {
			failures--
			return nil, errors.New("phone did not respond")
		}
		if req.GetCount() != conversationPageSize {
			return nil, fmt.Errorf("unexpected page size %d", req.GetCount())
		}
		resp := &gmproto.ListConversationsResponse{Conversations: pages[served]}
		served++
		if served < len(pages) {
			resp.Cursor = &gmproto.Cursor{LastItemID: strconv.Itoa(served)}
		}
		return resp, nil
	}, &calls
}

func TestListConversations(t *testing.T) {
	retryBaseDelay = 0
	pages := [][]*gmproto.Conversation{dated(9, 8), dated(7, 6), dated(5, 4)}

	t.Run("follows the cursor to the end without a cutoff", func(t *testing.T) {
		list, _ := fakeConversationList(pages, 0)
		got, err := listConversations(context.Background(), zerolog.Nop(), list, gmproto.ListConversationsRequest_INBOX, 0)
		if err != nil || len(got) != 6 {
			t.Fatalf("got %d conversations, err %v", len(got), err)
		}
	})

	t.Run("keeps the page that crossed the cutoff and stops", func(t *testing.T) {
		list, calls := fakeConversationList(pages, 0)
		got, err := listConversations(context.Background(), zerolog.Nop(), list, gmproto.ListConversationsRequest_INBOX, 8)
		if err != nil || len(got) != 4 || *calls != 2 {
			t.Fatalf("got %d conversations in %d calls, err %v", len(got), *calls, err)
		}
	})

	t.Run("retries a page the phone did not answer", func(t *testing.T) {
		list, calls := fakeConversationList(pages, 2)
		got, err := listConversations(context.Background(), zerolog.Nop(), list, gmproto.ListConversationsRequest_INBOX, 0)
		if err != nil || len(got) != 6 || *calls != 5 {
			t.Fatalf("got %d conversations in %d calls, err %v", len(got), *calls, err)
		}
	})

	t.Run("gives up after three attempts", func(t *testing.T) {
		list, calls := fakeConversationList(pages, 3)
		if _, err := listConversations(context.Background(), zerolog.Nop(), list, gmproto.ListConversationsRequest_INBOX, 0); err == nil || *calls != 3 {
			t.Fatalf("calls %d, err %v", *calls, err)
		}
	})
}

func TestMessageRecordReactions(t *testing.T) {
	const customID = "5f0c9a52-7d3e-4b18-9c46-2e8a1b7d6f30"
	record := messageRecord(&gmproto.Message{
		MessageID: "100",
		Reactions: []*gmproto.ReactionEntry{
			{Data: &gmproto.ReactionData{Unicode: "❤️", Type: gmproto.EmojiType_RED_HEART}, ParticipantIDs: []string{"2", "1"}},
			{Data: &gmproto.ReactionData{Type: gmproto.EmojiType_LIKE}, ParticipantIDs: []string{"3"}},
			{Data: &gmproto.ReactionData{Unicode: customID, Type: gmproto.EmojiType_EMOTIFY}},
		},
	})
	encoded, err := json.Marshal(record.Reactions)
	if err != nil {
		t.Fatal(err)
	}
	want := `[{"emoji":"❤️","type":"RED_HEART","participant_ids":["2","1"]},` +
		`{"emoji":"👍","type":"LIKE","participant_ids":["3"]},` +
		`{"emoji":"` + customID + `","type":"EMOTIFY","participant_ids":[]}]`
	if string(encoded) != want {
		t.Fatalf("reactions:\n got %s\nwant %s", encoded, want)
	}

	line, err := json.Marshal(messageRecord(&gmproto.Message{MessageID: "101"}))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(line), "reactions") {
		t.Fatalf("a message with no reactions should omit the field: %s", line)
	}
}
