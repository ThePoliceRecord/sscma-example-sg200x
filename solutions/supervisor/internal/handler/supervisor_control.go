package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"supervisor/pkg/logger"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var (
	globalForwarderManager *ForwarderManager
	reconnectMutex         sync.Mutex
	isConnected            bool
	reconnectAttempt       int
)

const (
	minReconnectDelay  = 1 * time.Second
	maxReconnectDelay  = 60 * time.Second
	maxReconnectJitter = 2 * time.Second
)

// StartSupervisorControl establishes control connection to relay server for on-demand streaming
func StartSupervisorControl() {
	relayURL := os.Getenv("EXTERNAL_RELAY_URL")
	cameraID := os.Getenv("CAMERA_ID")
	token := os.Getenv("RELAY_TOKEN")
	onDemand := os.Getenv("ON_DEMAND_STREAMING")

	if relayURL == "" || cameraID == "" {
		logger.Info("External relay disabled (set EXTERNAL_RELAY_URL and CAMERA_ID to enable)")
		return
	}

	if onDemand != "true" {
		logger.Info("On-demand streaming disabled, using always-on mode")
		StartExternalRelayForwarders()
		return
	}

	logger.Info("On-demand streaming enabled for camera %s", cameraID)

	// Initialize forwarder manager
	cameraBaseURL := "ws://localhost:8765/"
	globalForwarderManager = NewForwarderManager(cameraBaseURL, relayURL, cameraID, token)

	// Connect to relay with supervisor role
	go maintainControlConnection(relayURL, cameraID, token)
}

// maintainControlConnection keeps control connection alive with robust reconnection
func maintainControlConnection(relayURL, cameraID, token string) {
	reconnectAttempt = 0

	for {
		reconnectMutex.Lock()
		isConnected = false
		reconnectMutex.Unlock()

		if err := connectToRelay(relayURL, cameraID, token); err != nil {
			logger.Error("Control connection error: %v", err)
		}

		// Calculate exponential backoff with jitter
		delay := calculateReconnectDelay()
		logger.Info("Reconnecting control connection in %v... (attempt %d)", delay, reconnectAttempt+1)
		time.Sleep(delay)
	}
}

// calculateReconnectDelay calculates exponential backoff delay with jitter
func calculateReconnectDelay() time.Duration {
	reconnectAttempt++

	// Exponential backoff: 2^attempt seconds, capped at maxReconnectDelay
	delay := minReconnectDelay * time.Duration(1<<uint(reconnectAttempt))
	if delay > maxReconnectDelay {
		delay = maxReconnectDelay
	}

	// Add random jitter to prevent thundering herd
	jitter := time.Duration(0)
	if maxReconnectJitter > 0 {
		jitter = time.Duration(float64(maxReconnectJitter) * (0.5 + 0.5*float64(time.Now().UnixNano()%1000)/1000.0))
	}

	return delay + jitter
}

// connectToRelay establishes and maintains a control connection to the relay
func connectToRelay(relayURL, cameraID, token string) error {
	headers := http.Header{}
	headers.Set("Camera-ID", cameraID)
	headers.Set("Role", "supervisor")
	if token != "" {
		headers.Set("Authorization", "Bearer "+token)
	}

	logger.Info("Connecting to relay as supervisor for camera %s", cameraID)

	// Create dialer with timeout
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		ReadBufferSize:   1024,
		WriteBufferSize:  1024,
	}

	conn, _, err := dialer.Dial(relayURL, headers)
	if err != nil {
		return fmt.Errorf("failed to connect: %v", err)
	}
	defer conn.Close()

	logger.Info("Supervisor control connection established")

	// Reset reconnect counter on successful connection
	reconnectMutex.Lock()
	isConnected = true
	reconnectAttempt = 0
	reconnectMutex.Unlock()

	// Set up ping/pong to detect dead connections
	conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})

	// Start ping ticker
	pingTicker := time.NewTicker(30 * time.Second)
	defer pingTicker.Stop()

	// Channel for graceful shutdown
	done := make(chan struct{})

	// Send ping messages
	go func() {
		for {
			select {
			case <-pingTicker.C:
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					logger.Warning("Failed to send ping: %v", err)
					close(done)
					return
				}
			case <-done:
				return
			}
		}
	}()

	// Handle control messages from relay
	for {
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			close(done)
			return fmt.Errorf("read error: %v", err)
		}

		if messageType == websocket.TextMessage {
			var msg map[string]interface{}
			if err := json.Unmarshal(data, &msg); err != nil {
				logger.Warning("Failed to parse control message: %v", err)
				continue
			}

			msgType, ok := msg["type"].(string)
			if !ok {
				logger.Warning("Control message missing type field")
				continue
			}

			switch msgType {
			case "start_streaming":
				handleStartStreaming(conn, msg)
			case "stop_streaming":
				handleStopStreaming(conn, msg)
			default:
				logger.Debug("Unknown control message type: %s", msgType)
			}
		}
	}
}

// handleStartStreaming handles start_streaming command from relay
func handleStartStreaming(conn *websocket.Conn, msg map[string]interface{}) {
	cameraID, _ := msg["camera_id"].(string)
	channelsRaw, _ := msg["channels"].([]interface{})
	viewerCount, _ := msg["viewer_count"].(float64)

	channels := make([]string, 0, len(channelsRaw))
	for _, ch := range channelsRaw {
		if chStr, ok := ch.(string); ok {
			channels = append(channels, chStr)
		}
	}

	logger.Info("Received start_streaming command for camera %s, channels: %v, viewers: %d",
		cameraID, channels, int(viewerCount))

	if globalForwarderManager == nil {
		logger.Error("Forwarder manager not initialized")
		return
	}

	// Start forwarders for requested channels
	activeChannels := make([]string, 0, len(channels))
	for _, channel := range channels {
		if err := globalForwarderManager.Start(channel); err != nil {
			logger.Error("Failed to start forwarder for channel %s: %v", channel, err)
		} else {
			activeChannels = append(activeChannels, channel)
		}
	}

	// Send acknowledgment back to relay
	response := map[string]interface{}{
		"type":            "streaming_started",
		"camera_id":       cameraID,
		"channels_active": activeChannels,
	}
	sendStatusUpdate(conn, response)
}

// handleStopStreaming handles stop_streaming command from relay
func handleStopStreaming(conn *websocket.Conn, msg map[string]interface{}) {
	cameraID, _ := msg["camera_id"].(string)
	channelsRaw, _ := msg["channels"].([]interface{})

	channels := make([]string, 0, len(channelsRaw))
	for _, ch := range channelsRaw {
		if chStr, ok := ch.(string); ok {
			channels = append(channels, chStr)
		}
	}

	logger.Info("Received stop_streaming command for camera %s, channels: %v", cameraID, channels)

	if globalForwarderManager == nil {
		logger.Error("Forwarder manager not initialized")
		return
	}

	// Stop forwarders for requested channels
	for _, channel := range channels {
		globalForwarderManager.Stop(channel)
	}

	// Send acknowledgment back to relay
	response := map[string]interface{}{
		"type":      "streaming_stopped",
		"camera_id": cameraID,
	}
	sendStatusUpdate(conn, response)
}

// sendStatusUpdate sends a status message to the relay server
func sendStatusUpdate(conn *websocket.Conn, msg map[string]interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		logger.Error("Failed to marshal status update: %v", err)
		return
	}

	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		logger.Error("Failed to send status update: %v", err)
	} else {
		logger.Debug("Sent status update: %s", msg["type"])
	}
}
