ALTER TABLE "workforces" ADD CONSTRAINT "workforces_slug_safe_chk" CHECK ("slug" ~ '^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$');
