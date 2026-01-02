#include "mongoose.h"

#include <signal.h>
#include <stdio.h>
#include <string.h>

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
};

static void fn(struct mg_connection *c, int ev, void *ev_data) {
  if (ev != MG_EV_HTTP_MSG) return;

  struct mg_http_message *hm = (struct mg_http_message *) ev_data;
  const struct app_config *cfg = (const struct app_config *) c->fn_data;

  if (mg_strcmp(hm->uri, mg_str("/api/health")) == 0) {
    reply_json(c, 200, "{\"ok\":true,\"service\":\"oobe\"}");
    return;
  }

  struct mg_http_serve_opts opts;
  memset(&opts, 0, sizeof(opts));
  opts.root_dir = cfg->root_dir;
  opts.page404 = "index.html";
  mg_http_serve_dir(c, hm, &opts);
}

static void usage(const char *argv0) {
  fprintf(stderr, "Usage: %s [--listen http://0.0.0.0:8081] [--root /usr/share/oobe/www]\n", argv0);
}

int main(int argc, char **argv) {
  struct app_config cfg;
  cfg.listen_addr = "http://0.0.0.0:8081";
  cfg.root_dir = "/usr/share/oobe/www";

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--listen") == 0 && i + 1 < argc) {
      cfg.listen_addr = argv[++i];
    } else if (strcmp(argv[i], "--root") == 0 && i + 1 < argc) {
      cfg.root_dir = argv[++i];
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

  fprintf(stderr, "OOBE server listening on %s (root: %s)\n", cfg.listen_addr, cfg.root_dir);

  while (!g_should_exit) {
    mg_mgr_poll(&mgr, 250);
  }

  mg_mgr_free(&mgr);
  return 0;
}
