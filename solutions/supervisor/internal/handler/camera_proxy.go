package handler

import (
	"net/http"
	"supervisor/pkg/logger"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// CameraWebSocketProxy proxies WebSocket connections from browser (WSS) to camera-streamer (WS)
func CameraWebSocketProxy(w http.ResponseWriter, r *http.Request) {
	// Upgrade browser connection to WebSocket
	browserConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Error("Failed to upgrade browser connection: %v", err)
		return
	}
	defer browserConn.Close()

	// Connect to camera-streamer on localhost
	cameraURL := "ws://localhost:8765"
	cameraConn, _, err := websocket.DefaultDialer.Dial(cameraURL, nil)
	if err != nil {
		logger.Error("Failed to connect to camera-streamer: %v", err)
		browserConn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "Camera unavailable"))
		return
	}
	defer cameraConn.Close()

	logger.Info("WebSocket proxy established")

	// Bidirectional relay
	done := make(chan struct{}, 2)

	// Camera -> Browser
	go func() {
		defer func() { done <- struct{}{} }()
		for {
			messageType, message, err := cameraConn.ReadMessage()
			if err != nil {
				// Normal close, don't log as error
				if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway, websocket.CloseNoStatusReceived) {
					return
				}
				logger.Warning("Camera read error: %v", err)
				return
			}
			if err := browserConn.WriteMessage(messageType, message); err != nil {
				// Browser disconnected, normal
				return
			}
		}
	}()

	// Browser -> Camera
	go func() {
		defer func() { done <- struct{}{} }()
		for {
			messageType, message, err := browserConn.ReadMessage()
			if err != nil {
				// Normal close
				if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway, websocket.CloseNoStatusReceived) {
					return
				}
				logger.Warning("Browser read error: %v", err)
				return
			}
			if err := cameraConn.WriteMessage(messageType, message); err != nil {
				return
			}
		}
	}()

	// Wait for either direction to close
	<-done
	logger.Info("WebSocket proxy closed")
}
