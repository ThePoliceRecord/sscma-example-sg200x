#include "mongoose.h"

#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <errno.h>

static volatile sig_atomic_t g_should_exit = 0;

static void handle_signal(int signo) {
  (void) signo;
  g_should_exit = 1;
}

static void reply_json(struct mg_connection *c, int status, const char *json) {
  mg_http_reply(c, status, "Content-Type: application/json\r\n", "%s\n", json);
}

struct app_config {
  const char *listen_addr;
  const char *root_dir;
  const char *cert_file;
  const char *key_file;
};

static void get_mac_address(const char *interface, char *mac_buf, size_t buf_size) {
  char path[256];
  snprintf(path, sizeof(path), "/sys/class/net/%s/address", interface);
  
  FILE *fp = fopen(path, "r");
  if (fp) {
    if (fgets(mac_buf, buf_size, fp)) {
      // Remove newline
      size_t len = strlen(mac_buf);
      if (len > 0 && mac_buf[len-1] == '\n') {
        mac_buf[len-1] = '\0';
      }
    }
    fclose(fp);
  } else {
    strncpy(mac_buf, "unknown", buf_size);
  }
}

static void fn(struct mg_connection *c, int ev, void *ev_data) {
  if (ev != MG_EV_HTTP_MSG) return;

  struct mg_http_message *hm = (struct mg_http_message *) ev_data;
  const struct app_config *cfg = (const struct app_config *) c->fn_data;

  if (mg_strcmp(hm->uri, mg_str("/api/health")) == 0) {
    reply_json(c, 200, "{\"ok\":true,\"service\":\"oobe\"}");
    return;
  }

  if (mg_strcmp(hm->uri, mg_str("/api/getNetworkInfo")) == 0) {
    char eth0_mac[32] = {0};
    char wlan0_mac[32] = {0};
    
    get_mac_address("eth0", eth0_mac, sizeof(eth0_mac));
    get_mac_address("wlan0", wlan0_mac, sizeof(wlan0_mac));
    
    char response[512];
    snprintf(response, sizeof(response),
      "{\"ok\":true,\"interfaces\":{\"eth0\":{\"mac\":\"%s\"},\"wlan0\":{\"mac\":\"%s\"}}}",
      eth0_mac, wlan0_mac);
    
    reply_json(c, 200, response);
    return;
  }

  if (mg_strcmp(hm->uri, mg_str("/api/saveDeviceInfo")) == 0 && mg_strcmp(hm->method, mg_str("POST")) == 0) {
    // Create userdata directory if it doesn't exist
    mkdir("/userdata", 0755);
    
    // Write device info to file
    FILE *fp = fopen("/userdata/device_info.json", "w");
    if (fp) {
      fwrite(hm->body.buf, 1, hm->body.len, fp);
      fclose(fp);
      reply_json(c, 200, "{\"ok\":true,\"message\":\"Device info saved\"}");
    } else {
      char error_msg[256];
      snprintf(error_msg, sizeof(error_msg), "{\"ok\":false,\"error\":\"Failed to save: %s\"}", strerror(errno));
      reply_json(c, 500, error_msg);
    }
    return;
  }

  struct mg_http_serve_opts opts;
  memset(&opts, 0, sizeof(opts));
  opts.root_dir = cfg->root_dir;
  opts.page404 = "index.html";
  mg_http_serve_dir(c, hm, &opts);
}

static void usage(const char *argv0) {
  fprintf(stderr, "Usage: %s [OPTIONS]\n", argv0);
  fprintf(stderr, "Options:\n");
  fprintf(stderr, "  --listen URL         Listen address (default: https://0.0.0.0:8081)\n");
  fprintf(stderr, "  --root PATH          Web root directory (default: /usr/share/oobe/www)\n");
  fprintf(stderr, "  --cert PATH          TLS certificate file (default: /etc/supervisor/certs/cert.pem)\n");
  fprintf(stderr, "  --key PATH           TLS key file (default: /etc/supervisor/certs/key.pem)\n");
  fprintf(stderr, "  -h, --help           Show this help\n");
}

int main(int argc, char **argv) {
  struct app_config cfg;
  cfg.listen_addr = "https://0.0.0.0:8081";
  cfg.root_dir = "/usr/share/oobe/www";
  cfg.cert_file = "/etc/supervisor/certs/cert.pem";
  cfg.key_file = "/etc/supervisor/certs/key.pem";

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--listen") == 0 && i + 1 < argc) {
      cfg.listen_addr = argv[++i];
    } else if (strcmp(argv[i], "--root") == 0 && i + 1 < argc) {
      cfg.root_dir = argv[++i];
    } else if (strcmp(argv[i], "--cert") == 0 && i + 1 < argc) {
      cfg.cert_file = argv[++i];
    } else if (strcmp(argv[i], "--key") == 0 && i + 1 < argc) {
      cfg.key_file = argv[++i];
    } else if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0) {
      usage(argv[0]);
      return 0;
    } else {
      fprintf(stderr, "Unknown arg: %s\n", argv[i]);
      usage(argv[0]);
      return 2;
    }
  }

  signal(SIGINT, handle_signal);
  signal(SIGTERM, handle_signal);

  struct mg_mgr mgr;
  mg_mgr_init(&mgr);

  struct mg_connection *lc = mg_http_listen(&mgr, cfg.listen_addr, fn, &cfg);
  if (lc == NULL) {
    fprintf(stderr, "Failed to listen on %s\n", cfg.listen_addr);
    mg_mgr_free(&mgr);
    return 1;
  }

  // Enable TLS if using https://
  if (strncmp(cfg.listen_addr, "https://", 8) == 0) {
    struct mg_tls_opts tls_opts;
    memset(&tls_opts, 0, sizeof(tls_opts));
    tls_opts.cert = mg_str(cfg.cert_file);
    tls_opts.key = mg_str(cfg.key_file);
    
    mg_tls_init(lc, &tls_opts);
    fprintf(stderr, "OOBE server listening on %s (HTTPS, root: %s)\n", cfg.listen_addr, cfg.root_dir);
    fprintf(stderr, "Using TLS cert: %s\n", cfg.cert_file);
  } else {
    fprintf(stderr, "OOBE server listening on %s (HTTP, root: %s)\n", cfg.listen_addr, cfg.root_dir);
  }

  while (!g_should_exit) {
    mg_mgr_poll(&mgr, 250);
  }

  mg_mgr_free(&mgr);
  return 0;
}
