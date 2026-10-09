package verification

import (
	"testing"

	"limey.example/sentinel/internal/challenge"
)

func FuzzTokenParse(f *testing.F) {
	iss, _ := NewIssuer(testSecret, nil)
	tok, _ := iss.Issue(Payload{SiteKey: "fz"}, 0)
	f.Add(tok)
	f.Add("")
	f.Add("A.A")
	f.Add("...x....")
	f.Fuzz(func(t *testing.T, token string) {
		v, err := NewVerifier(testSecret, nil)
		if err != nil {
			t.Fatal(err)
		}
		// Must never panic regardless of input; an error return is fine.
		_, _ = v.Validate(token, "fz", "", "")
	})
}

func FuzzChallengeVerify(f *testing.F) {
	secret := "0123456789abcdef0123456789abcdef"
	params, _ := challenge.Issue(secret, "fz", "act", challenge.MinDifficulty, 60_000_000_000, timeNow())
	f.Add(params.Challenge, params.Salt, "123")
	f.Add("", "", "")
	f.Add("AAAA", "BBB", "zzz")
	f.Fuzz(func(t *testing.T, chB64, salt, nonce string) {
		p := challenge.Parameters{Challenge: chB64, Salt: salt, Difficulty: challenge.MinDifficulty}
		// Must never panic regardless of input; error is fine.
		_ = challenge.Verify(p, nonce, secret, "fz", "act", timeNow())
	})
}
