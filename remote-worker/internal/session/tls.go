package session

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log"
	"os"

	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

// TransportCredentials builds the worker's dial credentials from RELAY_TLS and RELAY_CA_FILE
// (P6.2 spec §3). caFile's PEM certificates are trusted IN ADDITION to the system roots, so an
// operator certificate from a public CA still verifies with or without it, and a self-signed relay
// certificate (setup.sh's default on OpenShift) verifies once its CA is given. The server name
// comes from RELAY_ADDR's host -- grpc-go's default -- and is never overridden. Shared by
// cmd/microvm-worker and cmd/worker so the two cannot diverge.
// systemCertPool is x509.SystemCertPool, a variable so a test can make it fail.
var systemCertPool = x509.SystemCertPool

func TransportCredentials(useTLS bool, caFile string) (credentials.TransportCredentials, error) {
	if !useTLS {
		if caFile != "" {
			return nil, fmt.Errorf("RELAY_CA_FILE is set but RELAY_TLS is not true: a CA file only means something over TLS")
		}
		return insecure.NewCredentials(), nil
	}
	cfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if caFile != "" {
		pemBytes, err := os.ReadFile(caFile)
		if err != nil {
			return nil, fmt.Errorf("RELAY_CA_FILE %s: %w", caFile, err)
		}
		pool, err := systemCertPool()
		if err != nil || pool == nil {
			// Practically unreachable on Linux, but never silent: without the system roots the worker
			// trusts ONLY caFile, which an operator certificate from a public CA would then fail.
			log.Printf("session: WARNING the system cert pool is unavailable (%v); RELAY_CA_FILE %s is the only trusted CA", err, caFile)
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pemBytes) {
			return nil, fmt.Errorf("RELAY_CA_FILE %s holds no PEM certificate", caFile)
		}
		cfg.RootCAs = pool
	}
	return credentials.NewTLS(cfg), nil
}
