-- Same fix as 20261116030000, for attachment notes.
--
-- Stage 2 gave attachment_notes.archived_by a foreign key to profiles, beside
-- updated_by's. With two keys to profiles, an unnamed `profiles(...)` embed from
-- attachment_notes is ambiguous (PGRST201). No query embeds it today, so nothing
-- is broken — this removes the trap before something does.
--
-- archived_by is a stamp written only by set_attachment_archived from the
-- caller's identity; it needs no foreign key.
alter table public.attachment_notes drop constraint if exists attachment_notes_archived_by_fkey;
