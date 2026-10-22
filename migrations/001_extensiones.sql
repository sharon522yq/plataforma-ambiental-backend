-- 001: extensiones necesarias.
-- Supabase las ofrece; en una base local se instalan igual.
create extension if not exists postgis;
create extension if not exists vector;
create extension if not exists pgcrypto;
