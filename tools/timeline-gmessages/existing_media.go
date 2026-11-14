package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

type existingMediaFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type existingMedia map[string]map[string]existingMediaFile

func readExistingMedia(path string) (existingMedia, error) {
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read existing media: %w", err)
	}
	var manifest existingMedia
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("parse existing media: %w", err)
	}
	return manifest, nil
}

// Check the actual bytes immediately before skipping a download. A database
// status alone cannot detect eviction, truncation, or same-size corruption.
func (known existingMedia) verified(messageID, mediaID string) (int64, bool) {
	entry, ok := known[messageID][mediaID]
	if !ok || mediaID == "" || entry.Size <= 0 {
		return 0, false
	}
	f, err := os.Open(entry.Path)
	if err != nil {
		return 0, false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != entry.Size {
		return 0, false
	}
	hash := sha256.New()
	size, err := io.Copy(hash, f)
	if err != nil || size != entry.Size || hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 {
		return 0, false
	}
	return size, true
}
