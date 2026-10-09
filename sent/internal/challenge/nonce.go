package challenge

import (
	"encoding/base64"
	"strconv"
)

// Nonce is a solution candidate; the browser SDK mirrors this encoding.
type Nonce []byte

// String base64-urlsafes a nonce so it can be posted back to the server.
func (n Nonce) String() string {
	return base64.RawURLEncoding.EncodeToString(n)
}

// EncodeNonce turns an iteration counter into the canonical nonce bytes.
func EncodeNonce(n int64) []byte {
	return []byte(strconv.FormatInt(n, 10))
}
