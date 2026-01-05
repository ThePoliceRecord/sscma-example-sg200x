#pragma once

#include <string>
#include <vector>
#include <atomic>
#include <thread>
#include <mutex>

extern "C" {
#include "mongoose.h"
}

// Forward H.264 frames to remote relay server via WebSocket
class RelayForwarder {
public:
    RelayForwarder(const std::string& relay_url, const std::string& camera_id,
                   const std::string& jwt_token = "");
    ~RelayForwarder();
    
    // Start/stop forwarding
    bool start();
    void stop();
    
    // Send frame to relay server
    void sendFrame(const uint8_t* data, size_t len, bool is_keyframe);
    
    // Check if connected
    bool isConnected() const { return connected_.load(); }
    
private:
    static void event_handler(struct mg_connection* c, int ev, void* ev_data);
    void connect();
    void reconnect_loop();
    
    std::string relay_url_;
    std::string camera_id_;
    std::string jwt_token_;
    
    struct mg_mgr mgr_;
    struct mg_connection* conn_;
    std::atomic<bool> connected_;
    std::atomic<bool> running_;
    std::thread worker_thread_;
    std::mutex send_mutex_;
};
