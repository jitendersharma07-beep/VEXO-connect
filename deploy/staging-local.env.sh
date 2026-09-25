#!/usr/bin/env bash
# Canonical, versioned configuration for the LOOPBACK staging stack.
#
# This file carries NO credentials and is safe to read. The database password
# is read out of the running container at run time by the local runner, the JWT
# secret lives in an untracked file beside it, and no SMTP password belongs
# here at all. Nothing in this file should ever be filled in with a secret —
# add a new untracked file instead.
#
# Source it; do not execute it:
#
#     . deploy/staging-local.env.sh
#
# It exists because two of these values are load-bearing in a way that is not
# obvious from either the nginx config or the frontend build, and both were
# wrong at once on 2026-09-25 while every command-line health probe passed.
# See deploy/staging-assert.sh, which turns each one into a check.

# --- topology ---------------------------------------------------------------
# The API and the vite preview both bind loopback. The nginx edge
# (vcx-staging-edge, run with --network host) is the only origin a browser is
# ever pointed at; it proxies /api/ to the API and serves the built SPA.
VCX_STAGING_API_PORT="${VCX_STAGING_API_PORT:-5540}"
VCX_STAGING_WEB_PORT="${VCX_STAGING_WEB_PORT:-5640}"
VCX_STAGING_EDGE_PORT="${VCX_STAGING_EDGE_PORT:-8120}"

# --- frontend base path -----------------------------------------------------
# PINNED, and the pin is the point.
#
# deploy/staging-edge.conf serves the SPA at the ROOT of the edge origin: it has
# `location /assets/` and `location ^~ /api/`, and no /pos/ prefix anywhere. A
# bundle built with VITE_BASE_PATH=/pos/ — the production value, for
# https://atcworkspace.com/pos/ — asks for /pos/assets/index-<hash>.js, which
# that config cannot serve. nginx answers it with the SPA fallback instead:
# HTTP 200, Content-Type text/html. The browser then refuses it as a module
# script and renders nothing.
#
# The failure is silent to every probe that checks a status code. `curl /`
# returns 200, `curl /api/health` returns 200, the container is Up — and the
# page is blank. That is exactly how it shipped on 2026-09-24 and survived
# until someone rendered it in a real browser.
#
# So: staging builds are ALWAYS root-based. If you need a /pos/-based bundle,
# that is the production image's job, not this stack's.
VCX_STAGING_BASE_PATH="/"

# --- backend origins --------------------------------------------------------
# APP_URL is the origin users are sent to (password-reset links and the like),
# so it is the edge, never the bare vite preview.
VCX_STAGING_APP_URL="http://127.0.0.1:${VCX_STAGING_EDGE_PORT}"

# CORS_ORIGIN is a comma-separated allow-list; backend/src/app.js splits it on
# "," and compares the request Origin against the result.
#
# It MUST contain the edge origin. Chrome sends `Origin` on a POST even when the
# request is same-origin, so the login POST from the SPA on :8120 arrives with
# `Origin: http://127.0.0.1:8120`. With only :5640 allowed, app.js raised
# "Not allowed by CORS" and login answered 500 — while every curl probe passed,
# because curl sends no Origin and the origin callback lets a missing Origin
# through. Command-line sign-in evidence cannot detect this; only a browser can.
#
# :5640 stays listed so the bare `vite preview` workflow keeps working.
VCX_STAGING_CORS_ORIGIN="http://127.0.0.1:${VCX_STAGING_EDGE_PORT},http://127.0.0.1:${VCX_STAGING_WEB_PORT}"

export VCX_STAGING_API_PORT VCX_STAGING_WEB_PORT VCX_STAGING_EDGE_PORT
export VCX_STAGING_BASE_PATH VCX_STAGING_APP_URL VCX_STAGING_CORS_ORIGIN
