package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

func TestDownloadMediaExistingCopies(t *testing.T) {
	for _, scenario := range []string{"valid", "missing", "truncated", "same-size corruption", "directory", "wrong message", "wrong media", "thumbnail only", "unavailable", "download failure"} {
		t.Run(scenario, func(t *testing.T) {
			dir := t.TempDir()
			content := "full image bytes"
			path := filepath.Join(dir, "stored")
			if err := os.WriteFile(path, []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
			known := existingMedia{"message": {"media": {Path: path, Size: int64(len(content)), SHA256: fmt.Sprintf("%x", sha256.Sum256([]byte(content)))}}}
			media := &gmproto.MediaContent{MediaID: "media", MediaName: "image.jpg", DecryptionKey: []byte("key"), ThumbnailMediaID: "thumb", ThumbnailDecryptionKey: []byte("thumb-key")}
			switch scenario {
			case "missing":
				os.Remove(path)
			case "truncated":
				os.WriteFile(path, []byte("short"), 0600)
			case "same-size corruption":
				os.WriteFile(path, []byte(strings.Repeat("x", len(content))), 0600)
			case "directory":
				os.Remove(path)
				os.Mkdir(path, 0700)
			case "wrong message":
				known["other"] = known["message"]
				delete(known, "message")
			case "wrong media":
				media.MediaID = "other"
			case "thumbnail only":
				known = nil
				media.DecryptionKey = nil
			case "unavailable":
				known = nil
				media.DecryptionKey = nil
				media.ThumbnailDecryptionKey = nil
			case "download failure":
				known = nil
			}
			msg := &gmproto.Message{MessageID: "message", MessageInfo: []*gmproto.MessageInfo{{Data: &gmproto.MessageInfo_MediaContent{MediaContent: media}}}}
			calls := 0
			ctx := t.Context()
			download := func(downloadCtx context.Context, id string, key []byte) (io.ReadCloser, error) {
				if downloadCtx != ctx {
					t.Fatal("download did not receive the caller's context")
				}
				calls++
				if scenario == "download failure" {
					return nil, fmt.Errorf("synthetic download failure")
				}
				if scenario == "thumbnail only" && id != "thumb" {
					t.Fatalf("downloaded %q, want thumbnail", id)
				}
				return io.NopCloser(strings.NewReader(content)), nil
			}
			records := downloadMedia(ctx, zerolog.Nop(), download, dir, msg, known)
			wantCalls, wantStatus := 1, "stored"
			switch scenario {
			case "valid":
				wantCalls, wantStatus = 0, "cached"
			case "thumbnail only":
				wantStatus = "thumbnail"
			case "unavailable":
				wantCalls, wantStatus = 0, "unavailable"
			case "download failure":
				wantStatus = "failed"
			}
			if calls != wantCalls || len(records) != 1 || records[0].Status != wantStatus {
				t.Fatalf("calls=%d records=%+v", calls, records)
			}
			if wantStatus == "cached" && records[0].Path != "" {
				t.Fatal("cached copy must not expose a path for the importer to remove")
			}
			if wantStatus == "stored" || wantStatus == "thumbnail" {
				data, err := os.ReadFile(records[0].Path)
				if err != nil || string(data) != content {
					t.Fatalf("downloaded bytes = %q, error %v", data, err)
				}
			}
		})
	}
}

func TestReadExistingMedia(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manifest.json")
	if _, err := readExistingMedia(path); err == nil {
		t.Fatal("missing manifest must fail")
	}
	os.WriteFile(path, []byte(`{"message":{"media":{"path":"/synthetic/image","size":123,"sha256":"abc"}}}`), 0600)
	known, err := readExistingMedia(path)
	if err != nil || known["message"]["media"].Size != 123 {
		t.Fatalf("manifest: %+v, %v", known, err)
	}
	os.WriteFile(path, []byte(`{broken`), 0600)
	if _, err := readExistingMedia(path); err == nil {
		t.Fatal("invalid manifest must fail")
	}
	if known, err := readExistingMedia(""); err != nil || known != nil {
		t.Fatal("optional manifest should preserve old dump behavior")
	}
}
