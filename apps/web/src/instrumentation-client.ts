import posthog from "posthog-js";
import { publicPageEvent } from "./lib/analytics";

const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;

if (process.env.NODE_ENV === "production" && token) {
  posthog.init(token, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
    defaults: "2026-05-30",
    capture_pageview: "history_change",
    capture_pageleave: true,
    autocapture: false,
    person_profiles: "never",
    internal_or_test_user_hostname: null,
    disable_session_recording: true,
    disable_surveys: true,
    before_send: publicPageEvent,
  });
}
