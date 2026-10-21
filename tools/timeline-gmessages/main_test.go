package main

import "testing"

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
