// De Caelo — shared client config. The anon key is meant to be public (Supabase's
// Row Level Security is the real access boundary, not secrecy of this key — see
// §4.3/§4.4 of the reference doc). EPHEMERIS_ACCESS_KEY is a deterrent only, same
// posture as the Worker's existing CHAT_ACCESS_KEY: visible in page source to
// anyone who looks, stops casual scraping, not real security.
window.DE_CAELO_CONFIG = {
  SUPABASE_URL: "https://kpqbqawkcgxqrydudyay.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtwcWJxYXdrY2d4cXJ5ZHVkeWF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc1MzY0ODMsImV4cCI6MjEwMzExMjQ4M30.jSLuLg2h5iajTLjaXozhcfBndw6oUBSfXMbWdfQ1Cmo",
  EPHEMERIS_URL: "https://de-caelo.onrender.com",
  EPHEMERIS_ACCESS_KEY: "XKSdrs2A07hwKmrrsX1SC0J3paCstkPqTy8aaRLgFunBzDv9wxKBiJwnJJP75Zo_",
  CHAT_ENDPOINT: "https://de-caelo-chat.nicholaskorody.workers.dev",
};
