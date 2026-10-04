package session

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

// selfSigned returns a server cert for "localhost" and its PEM, as setup.sh's self-signed relay
// certificate would be for the Route host.
func selfSigned(t *testing.T) (tls.Certificate, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"},
		DNSNames: []string{"localhost"}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, pemBytes
}

// serve starts a TLS gRPC server with the standard health service and returns a passthrough address.
func serve(t *testing.T, cert tls.Certificate) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := grpc.NewServer(grpc.Creds(credentials.NewServerTLSFromCert(&cert)))
	healthpb.RegisterHealthServer(s, health.NewServer())
	go func() { _ = s.Serve(lis) }()
	t.Cleanup(s.Stop)
	_, port, _ := net.SplitHostPort(lis.Addr().String())
	return "passthrough:///localhost:" + port
}

func check(t *testing.T, addr string, creds credentials.TransportCredentials) error {
	t.Helper()
	// Use DialOptions so the test exercises the same configuration production uses.
	conn, err := grpc.NewClient(addr, DialOptions(creds)...)
	if err != nil {
		return err
	}
	defer conn.Close()
	// Perform a health check RPC to validate the TLS connection works.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err = healthpb.NewHealthClient(conn).Check(ctx, &healthpb.HealthCheckRequest{})
	return err
}

func TestTransportCredentials(t *testing.T) {
	cert, caPEM := selfSigned(t)
	addr := serve(t, cert)
	dir := t.TempDir()
	caFile := filepath.Join(dir, "relay-ca.crt")
	if err := os.WriteFile(caFile, caPEM, 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("with RELAY_CA_FILE a self-signed relay verifies", func(t *testing.T) {
		creds, err := TransportCredentials(true, caFile)
		if err != nil {
			t.Fatal(err)
		}
		if err := check(t, addr, creds); err != nil {
			t.Fatalf("dial with the CA file failed: %v", err)
		}
	})
	t.Run("without it the same relay is refused (system roots only)", func(t *testing.T) {
		creds, err := TransportCredentials(true, "")
		if err != nil {
			t.Fatal(err)
		}
		if err := check(t, addr, creds); err == nil {
			t.Fatal("a self-signed relay verified against system roots alone")
		}
	})
	t.Run("RELAY_CA_FILE without RELAY_TLS is a contradiction", func(t *testing.T) {
		if _, err := TransportCredentials(false, caFile); err == nil ||
			!strings.Contains(err.Error(), "RELAY_CA_FILE") || !strings.Contains(err.Error(), "RELAY_TLS") {
			t.Fatalf("want an error naming both variables, got %v", err)
		}
	})
	t.Run("an unreadable file names its path", func(t *testing.T) {
		missing := filepath.Join(dir, "missing.crt")
		if _, err := TransportCredentials(true, missing); err == nil || !strings.Contains(err.Error(), missing) {
			t.Fatalf("want an error naming %s, got %v", missing, err)
		}
	})
	t.Run("a file with no PEM certificate names its path", func(t *testing.T) {
		junk := filepath.Join(dir, "junk.crt")
		_ = os.WriteFile(junk, []byte("not a certificate\n"), 0o644)
		if _, err := TransportCredentials(true, junk); err == nil || !strings.Contains(err.Error(), junk) {
			t.Fatalf("want an error naming %s, got %v", junk, err)
		}
	})
	t.Run("plaintext without a CA file stays plaintext", func(t *testing.T) {
		creds, err := TransportCredentials(false, "")
		if err != nil || creds.Info().SecurityProtocol != "insecure" {
			t.Fatalf("want insecure credentials, got %v, %v", creds, err)
		}
	})
}
