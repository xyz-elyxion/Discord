package auth

import (
	"strings"
	"testing"
)

func TestHashVerifyRoundtrip(t *testing.T) {
	h, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$") {
		t.Fatalf("unexpected hash: %s", h)
	}
	ok, err := VerifyPassword("correct horse battery staple", h)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("correct password rejected")
	}
	ok, err = VerifyPassword("wrong", h)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("wrong password accepted")
	}
}

func TestHashIsSalted(t *testing.T) {
	a, _ := HashPassword("same")
	b, _ := HashPassword("same")
	if a == b {
		t.Fatal("identical passwords must produce different hashes (salted)")
	}
}

func TestMalformedHashRejected(t *testing.T) {
	for _, bad := range []string{"", "$argon2id$", "$bcrypt$abc", "$argon2id$v=19$m=bogus$abc$def"} {
		if _, err := VerifyPassword("x", bad); err == nil {
			t.Fatalf("expected rejection for %q", bad)
		}
	}
}

func TestTokensUnique(t *testing.T) {
	set := map[string]bool{}
	for i := 0; i < 100; i++ {
		tok, err := NewToken()
		if err != nil {
			t.Fatal(err)
		}
		if len(tok) != 64 {
			t.Fatalf("token length = %d", len(tok))
		}
		if set[tok] {
			t.Fatal("duplicate token")
		}
		set[tok] = true
	}
}

func TestHashTokenStable(t *testing.T) {
	if HashToken("abc") != HashToken("abc") {
		t.Fatal("hash must be deterministic")
	}
	if HashToken("abc") == HashToken("abd") {
		t.Fatal("different tokens must hash differently")
	}
	if len(HashToken("abc")) != 64 {
		t.Fatal("sha256 hex should be 64 chars")
	}
}

func TestRBAC(t *testing.T) {
	if !RoleAtLeast(RoleAdmin, RoleOperator) {
		t.Fatal("admin should have operator powers")
	}
	if !RoleAtLeast(RoleOperator, RoleViewer) {
		t.Fatal("operator should have viewer powers")
	}
	if RoleAtLeast(RoleViewer, RoleOperator) {
		t.Fatal("viewer must not have operator powers")
	}
	if RoleAtLeast(RoleViewer, RoleAdmin) {
		t.Fatal("viewer must not have admin powers")
	}
}

func TestConstantTimeEqual(t *testing.T) {
	if !ConstantTimeEqual("secret", "secret") {
		t.Fatal("equal strings should match")
	}
	if ConstantTimeEqual("secret", "secretx") {
		t.Fatal("unequal strings must not match")
	}
	if ConstantTimeEqual("", "") != true {
		t.Fatal("empty vs empty is equal")
	}
}
