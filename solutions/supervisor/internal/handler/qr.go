package handler

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"supervisor/internal/api"
	"supervisor/pkg/logger"
)

// QRHandler handles QR code scanning API requests.
type QRHandler struct {
	qrReaderPath  string
	activeScan    *QRScanSession
	scanMutex     sync.Mutex
	completed     map[string]*CompletedScan
	cleanupTicker *time.Ticker
	stopCleanup   chan struct{}
}

// QRScanSession represents an active QR scan session.
type QRScanSession struct {
	ScanID    string
	StartedAt time.Time
	cmd       *exec.Cmd
	done      chan struct{}
	result    *QRScanResult
	status    string
}

// CompletedScan represents a completed scan result.
type CompletedScan struct {
	Result      *QRScanResult
	Status      string
	StartedAt   time.Time
	CompletedAt time.Time
	Expiry      time.Time
}

// QRScanResult represents the result from qr-reader binary.
type QRScanResult struct {
	Success         bool     `json:"success"`
	Reason          string   `json:"reason,omitempty"`
	QRCodes         []QRCode `json:"qr_codes,omitempty"`
	Count           int      `json:"count,omitempty"`
	FramesProcessed int      `json:"frames_processed,omitempty"`
	DetectionTimeMS int64    `json:"detection_time_ms,omitempty"`
	ScanDurationMS  int64    `json:"scan_duration_ms,omitempty"`
	SchemaExpected  string   `json:"schema_expected,omitempty"`
	QRData          string   `json:"qr_data,omitempty"`
	Error           string   `json:"error,omitempty"`
}

// QRCode represents a decoded QR code.
type QRCode struct {
	Data      string `json:"data"`
	Version   int    `json:"version"`
	ECCLevel  string `json:"ecc_level"`
	Mask      int    `json:"mask,omitempty"`
	DataType  int    `json:"data_type,omitempty"`
	Validated bool   `json:"validated"`
}

// StartScanRequest represents a scan start request.
type StartScanRequest struct {
	Timeout    int    `json:"timeout"`
	MaxResults int    `json:"max_results"`
	Schema     string `json:"schema,omitempty"`
}

// generateUUID generates a UUID v4 string
func generateUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	// Set version (4) and variant bits
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// NewQRHandler creates a new QRHandler.
func NewQRHandler() *QRHandler {
	h := &QRHandler{
		qrReaderPath: "/usr/bin/qr-reader",
		completed:    make(map[string]*CompletedScan),
		stopCleanup:  make(chan struct{}),
	}

	// Start cleanup goroutine
	h.cleanupTicker = time.NewTicker(1 * time.Minute)
	go h.cleanupExpired()

	return h
}

// Close stops the cleanup goroutine.
func (h *QRHandler) Close() {
	close(h.stopCleanup)
	if h.cleanupTicker != nil {
		h.cleanupTicker.Stop()
	}

	// Kill active scan if any
	h.scanMutex.Lock()
	if h.activeScan != nil && h.activeScan.cmd != nil && h.activeScan.cmd.Process != nil {
		logger.Info("Killing active QR scan process")
		h.activeScan.cmd.Process.Kill()
	}
	h.scanMutex.Unlock()
}

// cleanupExpired removes expired completed scans.
func (h *QRHandler) cleanupExpired() {
	for {
		select {
		case <-h.stopCleanup:
			return
		case <-h.cleanupTicker.C:
			h.scanMutex.Lock()
			now := time.Now()
			cleaned := 0
			for scanID, scan := range h.completed {
				if now.After(scan.Expiry) {
					delete(h.completed, scanID)
					cleaned++
				}
			}
			if cleaned > 0 {
				logger.Info("Cleaned up %d expired QR scan session(s)", cleaned)
			}
			h.scanMutex.Unlock()
		}
	}
}

// StartScan starts a new QR code scan session.
func (h *QRHandler) StartScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	var req StartScanRequest
	if err := api.ParseJSONBody(r, &req); err != nil {
		api.WriteError(w, -1, "Invalid request body")
		return
	}

	// Set defaults
	if req.Timeout <= 0 {
		req.Timeout = 30
	}
	if req.MaxResults == 0 {
		req.MaxResults = 1
	}

	h.scanMutex.Lock()
	defer h.scanMutex.Unlock()

	// Check for concurrent scan
	if h.activeScan != nil {
		w.WriteHeader(http.StatusConflict)
		api.WriteJSON(w, 409, map[string]interface{}{
			"code": 409,
			"msg":  "Scan already in progress",
			"data": map[string]string{
				"active_scan_id": h.activeScan.ScanID,
			},
		})
		return
	}

	// Create scan session
	scanID := generateUUID()
	startedAt := time.Now()

	// Build command arguments
	args := []string{
		"--timeout", strconv.Itoa(req.Timeout),
		"--max-results", strconv.Itoa(req.MaxResults),
	}
	if req.Schema != "" {
		args = append(args, "--schema", req.Schema)
	}

	logger.Info("Starting QR scan %s with args: %v", scanID, args)

	// Create command
	cmd := exec.Command(h.qrReaderPath, args...)
	var stdoutBuf, stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	// Start process
	if err := cmd.Start(); err != nil {
		logger.Error("Failed to start qr-reader: %v", err)
		api.WriteError(w, -1, "Failed to start QR scan")
		return
	}

	session := &QRScanSession{
		ScanID:    scanID,
		StartedAt: startedAt,
		cmd:       cmd,
		done:      make(chan struct{}),
		status:    "scanning",
	}
	h.activeScan = session

	// Monitor process in goroutine
	go func() {
		defer close(session.done)

		// Wait for process
		err := cmd.Wait()
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			}
		}

		// Parse result
		stdout := strings.TrimSpace(stdoutBuf.String())
		stderr := stderrBuf.String()

		result := &QRScanResult{}
		if stdout != "" {
			if jsonErr := json.Unmarshal([]byte(stdout), result); jsonErr != nil {
				logger.Error("Failed to parse qr-reader output: %v", jsonErr)
				result = &QRScanResult{
					Success: false,
					Reason:  "parse_error",
					Error:   "Failed to parse output",
				}
			}
		}

		// Determine status
		var status string
		if result.Success {
			status = "complete"
		} else if exitCode == 1 {
			status = "timeout"
		} else if exitCode == 3 {
			status = "cancelled"
			result.Reason = "cancelled"
		} else {
			status = "error"
		}

		logger.Info("QR scan %s ended with status: %s, exit code: %d", scanID, status, exitCode)
		if stderr != "" {
			logger.Debug("QR scan stderr: %s", stderr)
		}

		// Store completed scan
		h.scanMutex.Lock()
		h.completed[scanID] = &CompletedScan{
			Result:      result,
			Status:      status,
			StartedAt:   startedAt,
			CompletedAt: time.Now(),
			Expiry:      time.Now().Add(5 * time.Minute),
		}
		h.activeScan = nil
		h.scanMutex.Unlock()
	}()

	// Return scan info
	w.WriteHeader(http.StatusCreated)
	api.WriteJSON(w, 0, map[string]interface{}{
		"code": 0,
		"msg":  "Scan started",
		"data": map[string]interface{}{
			"scan_id":    scanID,
			"status":     "scanning",
			"started_at": startedAt.Format(time.RFC3339),
		},
	})
}

// GetScanStatus gets the status of a QR scan session.
func (h *QRHandler) GetScanStatus(w http.ResponseWriter, r *http.Request) {
	scanID := r.URL.Query().Get("scan_id")
	if scanID == "" {
		// Try path parameter
		parts := strings.Split(r.URL.Path, "/")
		if len(parts) > 0 {
			scanID = parts[len(parts)-1]
		}
	}

	if scanID == "" {
		api.WriteError(w, -1, "scan_id required")
		return
	}

	h.scanMutex.Lock()
	defer h.scanMutex.Unlock()

	// Check active scan
	if h.activeScan != nil && h.activeScan.ScanID == scanID {
		api.WriteSuccess(w, map[string]interface{}{
			"scan_id":    scanID,
			"status":     "scanning",
			"started_at": h.activeScan.StartedAt.Format(time.RFC3339),
		})
		return
	}

	// Check completed scans
	if completed, ok := h.completed[scanID]; ok {
		api.WriteSuccess(w, map[string]interface{}{
			"scan_id":      scanID,
			"status":       completed.Status,
			"started_at":   completed.StartedAt.Format(time.RFC3339),
			"completed_at": completed.CompletedAt.Format(time.RFC3339),
			"result":       completed.Result,
		})
		return
	}

	w.WriteHeader(http.StatusNotFound)
	api.WriteJSON(w, 404, map[string]interface{}{
		"code": 404,
		"msg":  "Scan not found or expired",
		"data": nil,
	})
}

// CancelScan cancels an active QR scan.
func (h *QRHandler) CancelScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	scanID := r.URL.Query().Get("scan_id")
	if scanID == "" {
		// Try path parameter
		parts := strings.Split(r.URL.Path, "/")
		if len(parts) > 0 {
			scanID = parts[len(parts)-1]
		}
	}

	if scanID == "" {
		api.WriteError(w, -1, "scan_id required")
		return
	}

	h.scanMutex.Lock()
	defer h.scanMutex.Unlock()

	if h.activeScan != nil && h.activeScan.ScanID == scanID {
		logger.Info("Cancelling QR scan %s", scanID)
		if h.activeScan.cmd != nil && h.activeScan.cmd.Process != nil {
			h.activeScan.cmd.Process.Signal(os.Interrupt) // Send SIGTERM
		}

		api.WriteSuccess(w, map[string]interface{}{
			"scan_id": scanID,
			"status":  "cancelled",
		})
		return
	}

	w.WriteHeader(http.StatusNotFound)
	api.WriteJSON(w, 404, map[string]interface{}{
		"code": 404,
		"msg":  "Scan not found or already completed",
		"data": nil,
	})
}

// GetHealth returns QR service health information.
func (h *QRHandler) GetHealth(w http.ResponseWriter, r *http.Request) {
	h.scanMutex.Lock()
	defer h.scanMutex.Unlock()

	var activeScan interface{}
	if h.activeScan != nil {
		activeScan = map[string]interface{}{
			"scan_id":    h.activeScan.ScanID,
			"started_at": h.activeScan.StartedAt.Format(time.RFC3339),
		}
	}

	api.WriteSuccess(w, map[string]interface{}{
		"status":                "ready",
		"active_scan":           activeScan,
		"completed_scans_count": len(h.completed),
		"qr_reader_path":        h.qrReaderPath,
	})
}
