-- Close direct storage access for clients: the "files" edge function is the
-- only way to read a file, and it removes objects on the app's behalf.
-- Apply ONLY after the build that reads through the function is live.
--
-- Found while building the gateway: three old permissive policies on the
-- 'attachments' bucket let ANY signed-in user read, upload and delete ANY
-- object in it — whatever project it belonged to. Permissive policies are
-- OR-ed, so the strict per-project policies next to them never mattered.
--
-- After this migration a client (anon or authenticated) can only upload, and
-- only into a project it is a member of. Reading, signing URLs, listing and
-- deleting go through the server (service_role bypasses RLS). Undo, if ever
-- needed: 20261119010000 has no data changes, recreating the policies is enough.

drop policy if exists "Authenticated users can read attachments" on storage.objects;
drop policy if exists "Authors can delete their attachments" on storage.objects;
drop policy if exists "Authenticated users can upload attachments" on storage.objects;

-- Reads (download, signed URLs, list): server only.
drop policy if exists attachments_read on storage.objects;
drop policy if exists task_attachments_read on storage.objects;

-- Deletes: the function removes a file once nothing references it.
drop policy if exists attachments_delete on storage.objects;
drop policy if exists task_attachments_delete on storage.objects;

-- Uploads stay: 'attachments' for members of the project in the first path
-- segment (attachments_upload, unchanged). Jira imports run as the service
-- role, so clients no longer upload into 'task-attachments' at all.
drop policy if exists task_attachments_upload on storage.objects;
