#include "relay_forwarder.h"
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define TAG "relay-forwarder"

RelayForwarder::RelayForwarder(const std::string& relay_url, const std::string& camera_id,
                               const std::string& jwt_token)
    : relay_url_(relay_url)
    , camera_id_(camera_id)
    , jwt_token_(jwt_token)
    , conn_(nullptr)
    , connected_(false)
    , running_(false) {
}

RelayForwarder::~RelayForwarder() {
    stop();
}

bool RelayForwarder::start() {
    if (running_.load()) {
        return true;  // Already running
    }
    
    running_.store(true);
    
    // Start worker thread for connection management
    worker_thread_ = std::thread(&RelayForwarder::reconnect_loop, this);
    
    return true;
}

void RelayForwarder::stop() {
    running_.store(false);
    
    if (worker_thread_.joinable()) {
        worker_thread_.join();
    }
    
    if (conn_) {
        conn_->is_draining = 1;
        conn_ = nullptr;
    }
    
    mg_mgr_free(&mgr_);
}

void RelayForwarder::sendFrame(const uint8_t* data, size_t len, bool is_keyframe) {
    if (!connected_.load() || !conn_ || !conn_->is_websocket) {
        return;  // Not connected, drop frame
    }
    
    std::lock_guard<std::mutex> lock(send_mutex_);
    mg_ws_send(conn_, data, len, WEBSOCKET_OP_BINARY);
}

void RelayForwarder::event_handler(struct mg_connection* c, int ev, void* ev_data) {
    RelayForwarder* self = (RelayForwarder*)c->fn_data;
    
    if (ev == MG_EV_ERROR) {
        char* errmsg = (char*)ev_data;
        printf("%s: Connection error: %s\n", TAG, errmsg ? errmsg : "unknown");
        self->connected_.store(false);
    } else if (ev == MG_EV_CONNECT) {
        printf("%s: TCP connection established, sending WebSocket upgrade\n", TAG);
        // Connection established, upgrade to WebSocket
        struct mg_str host = mg_url_host(self->relay_url_.c_str());
        
        mg_printf(c,
            "GET /ws HTTP/1.1\r\n"  // Changed from HTTP/1.0
            "Host: %.*s\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
            "Camera-ID: %s\r\n"
            "%s%s%s"
            "\r\n",
            (int)host.len, host.buf,
            self->camera_id_.c_str(),
            self->jwt_token_.empty() ? "" : "Authorization: Bearer ",
            self->jwt_token_.c_str(),
            self->jwt_token_.empty() ? "" : "\r\n");
    } else if (ev == MG_EV_HTTP_MSG) {
        printf("%s: Received HTTP response\n", TAG);
        struct mg_http_message* hm = (struct mg_http_message*)ev_data;
        printf("%s: HTTP status: %d\n", TAG, mg_http_status(hm));
        if (mg_http_status(hm) == 101) {
            // WebSocket upgrade successful
            printf("%s: Connected to relay server\n", TAG);
            self->connected_.store(true);
        } else {
            printf("%s: WebSocket upgrade failed: %d\n", TAG, mg_http_status(hm));
            c->is_draining = 1;
        }
    } else if (ev == MG_EV_WS_OPEN) {
        printf("%s: WebSocket connection opened\n", TAG);
        self->connected_.store(true);
    } else if (ev == MG_EV_WS_MSG) {
        // Handle messages from server (control commands, etc.)
        struct mg_ws_message* wm = (struct mg_ws_message*)ev_data;
        printf("%s: Received message from relay: %.*s\n", TAG, (int)wm->data.len, wm->data.buf);
    } else if (ev == MG_EV_CLOSE) {
        printf("%s: Connection closed\n", TAG);
        self->connected_.store(false);
    } else {
        // Log other events for debugging
        printf("%s: Event %d\n", TAG, ev);
    }
}

void RelayForwarder::connect() {
    mg_mgr_init(&mgr_);
    
    printf("%s: Connecting to relay server: %s\n", TAG, relay_url_.c_str());
    
    conn_ = mg_ws_connect(&mgr_, relay_url_.c_str(), event_handler, this, NULL);
    if (!conn_) {
        printf("%s: Failed to initiate connection\n", TAG);
        return;
    }
}

void RelayForwarder::reconnect_loop() {
    int retry_delay = 1;  // Start with 1 second delay
    const int max_delay = 60;  // Max 60 seconds between retries
    
    connect();
    
    while (running_.load()) {
        mg_mgr_poll(&mgr_, 1000);  // Poll every 1 second
        
        // Check if we need to reconnect
        if (!connected_.load() && running_.load()) {
            printf("%s: Disconnected, reconnecting in %d seconds...\n", TAG, retry_delay);
            sleep(retry_delay);
            
            // Exponential backoff
            retry_delay = (retry_delay * 2) > max_delay ? max_delay : (retry_delay * 2);
            
            if (conn_) {
                conn_->is_draining = 1;
            }
            
            mg_mgr_free(&mgr_);
            connect();
        } else if (connected_.load()) {
            // Reset retry delay on successful connection
            retry_delay = 1;
        }
    }
    
    mg_mgr_free(&mgr_);
}
