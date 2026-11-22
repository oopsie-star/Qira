-- Stage 8 data migration, block 8.2 (deleted tasks → archived). Generated from the dry-run plan that
-- was approved (2026-11-22); every change is written to data_migration_log with the
-- row before and after, so the block can be undone row by row. The block
-- checks its own counts against the dry-run and aborts as a whole if they differ.
--
-- The 150 tasks in the trash become archived: out of the working area as
-- before, but kept and restorable like any archived task. Epic statuses are
-- unchanged: sync_epic_status counts deleted and archived tasks alike.

do $$
declare
  r   record;
  v_n integer := 0;
begin
  for r in select t.id, t.key, t.status from public.tasks t
            where t.id = any(array[
    '70e485f3-9868-41ca-bdc6-ae79fcba801b',
    '4d2d3d53-ae51-4782-a4a9-4381e546e89b',
    '661b4a44-93ee-4850-99ac-1377d6afc6f4',
    '0211ac0a-b846-4c5c-bf6a-7865955873d8',
    '3c99ad68-9741-4a72-b91d-ef411e1fb415',
    '8be58054-38f2-42e0-9d2c-842b78fbc903',
    '4a29f8ee-32ba-4968-ac9d-c1daee0d0dff',
    'dcf99d98-2a1e-43f6-8057-1e6bae7cbd5c',
    '1a1eb1ef-094c-4a2f-9b8e-00681e518801',
    'bee1e6b4-cc45-480d-92b4-b0c22ebec640',
    '4ce66b92-b236-446a-9efc-0fe71b9f1b3a',
    '27aab09f-54e1-49b2-92bb-0d58adbc95b0',
    'a4767db3-e155-49bc-a955-25d1bc5d8456',
    '897df4ce-86ac-4c5d-9ec0-221ea150e6d1',
    '515121fd-ff36-49a3-bfbd-64df7688d45c',
    '831348d7-2e3b-4cee-b3a5-7a624ce44d57',
    'a58b2213-0cb1-4879-a18f-ee9eaff9bc95',
    '66eb3156-f9be-4bbd-a9e8-6c9e88b73823',
    '5a25b76b-baaf-461f-9880-e6f3f5fc1db3',
    '1bdc2627-b7cd-4447-a67e-aa12ebbd4fde',
    '906d47ab-d11d-4105-bd46-a937f11f13ed',
    'b211088c-6c14-40d3-b41d-ca77343ce46a',
    'e3404eaa-9d6f-4bee-ac18-4aefb49c05e0',
    '01f385c9-8451-45a2-a780-df146d72a43e',
    'c2f960da-86bf-409c-b59a-00c19eea0e14',
    '465f3a1c-8f0f-4511-8f65-1f0d1888d4f8',
    'fdb5dc2f-8e28-49a4-89af-08946864d879',
    'c36c90b0-f90f-4612-9ff9-07735c20830d',
    '0680403a-defc-419a-92d3-62201eca68d2',
    '6e428a44-e271-46ac-b03c-bfc6d209673d',
    '90b97b19-287c-4019-a2b1-b491af9ecb62',
    '01a6a7cf-27a8-4c4f-be98-0f064e2ba031',
    '435cb173-8c32-4170-87ed-d2e8779b8bf5',
    'f7fa83ef-c227-4f5a-811d-9da79cb5d7cb',
    '890de069-e90b-404b-b8b6-d5fe7f52b789',
    'c4c6ac12-4e0a-4163-9f23-a5dea761cca7',
    '6f603ab3-6ce9-4e39-8bbb-278d633eb3d9',
    'fbef25e6-75f2-44c2-bfe1-e64080f3165c',
    '44295f1f-8a04-41db-a166-459dffe7020e',
    '8766c1e9-a60a-4df3-93ed-084279d6cd8d',
    '5d28890e-533f-40c6-9409-c6c6d0bf0a77',
    '48ddb581-22de-43de-ac2e-d01aff8e5772',
    'addd01e1-efb2-4e08-99cb-6e76740a929c',
    'fdeb699e-6429-4e88-a715-b4f1982137bc',
    'f426df89-98e5-4892-b1ed-a8a6d84df2ae',
    'e2e02f41-e998-4cb0-a1bd-48412d492a40',
    '9639d3c3-96e4-4eb4-b4f0-52648a6499f4',
    'ddf6c09e-e460-4e26-a662-f63c955fd8a3',
    '531151c3-411e-44ca-99a2-42a1a6788a5b',
    'd4659446-01b1-4a53-a8d1-8e36339beca8',
    '23af961f-ad38-420b-9e4f-8b1264021689',
    '70ef91c6-7c3e-45e9-a721-1b545231966c',
    '5dd97a61-7247-4497-a95a-6e09dc5ebdd0',
    '2e2450bd-dbc3-45ee-a60d-0a6c231bfff4',
    '5525812d-f954-4b7a-8f5d-75298eedaee1',
    '334e0169-13b4-40ed-bbf1-5a06d4639fc8',
    'bb16bdd9-27e6-43ee-a429-afb3771cf71b',
    '344a20fd-d5d3-43d0-b4a6-03352c9e510f',
    '6a939ded-81c2-49ce-b4f6-e35c2926b955',
    '780233f9-289d-4610-8f76-e0a0984e962a',
    '20fa40cd-5606-4f8a-ba1b-ce4e016e1f9d',
    'b3b985c1-8e06-4c4c-a9dc-c5fbe62dfed9',
    '787698e3-abb7-4ee6-8d76-bcc2e4d6e0f8',
    'd6e35568-339e-4e1f-8a9c-db30577e9878',
    '75d31bd3-b086-461a-be65-eb2c1a87240f',
    'f7cfcfc5-237e-42db-8f18-e6b65ae273e8',
    'c38b6388-c065-42fa-af4a-87f579ddd66a',
    '64511506-e946-40a7-897e-90aee52e4ff2',
    '9b087e30-be0e-4909-baab-a90f1d9d736d',
    '7d946afe-1d12-440a-aa17-72512c686c3d',
    '81de9501-f967-4323-befc-a8c45158920d',
    'f16751b4-c023-49f7-a4db-3076c062cad4',
    'e20f4760-369c-4002-9ef6-5608c3c550b4',
    '113947c3-6310-4652-9410-4ba2a7a2cd49',
    'a0f82c82-3c3b-4e6b-a75f-4529e73a64db',
    '4046a2e2-0ae7-4b4d-9430-af347bb4b0cf',
    'ac9f7671-6a37-4603-ab87-e98198498955',
    'b773ad2a-e46f-4812-9afa-58a1dfa89a3d',
    '65d64255-d646-49ec-b1fb-af289a1afd0d',
    '652202c0-b2ee-4c7f-ace2-6f78fa9372fc',
    '54cef927-96f4-4dd8-b0f9-29a1a143e971',
    '74e6a915-7493-44a6-a76e-b321bef35528',
    'b39937ad-b600-4396-bd33-f5c3c5a1e118',
    'e2ec1647-8a91-457a-8d77-1282a40ca241',
    'da2436d3-7618-4bfd-aefe-f7435e7bffd7',
    '926707f6-6ec7-41b6-9f86-e977f1ec3d72',
    '028c8a12-da47-48b8-924c-06668ee18bcc',
    '3e4f6b7a-fcfd-4cfe-b95f-7ab59d28470f',
    'd66a5a58-80c5-4843-987c-b2224f1b3542',
    '9498e743-67cd-473d-8634-b86ae83c1839',
    'e897a10a-ac75-41ca-9dc1-57d148395f38',
    '18d96d4d-ac00-496a-9995-54160df89523',
    'ece44d29-a3fa-4ab6-833b-b23edd8309cd',
    '094ef92f-1029-4637-b93b-4e4e8ceb80a3',
    '0e35fed3-3eae-4e6c-8506-d20d0133bc62',
    'b96c97c4-b27b-4900-9979-ba1f8b23145a',
    '72f5ff60-e333-47f3-81ca-4dc1a8cdcae6',
    'b7ec3b66-004c-4328-8516-c9a9ad06dc58',
    '55afd61a-2b88-448c-8c68-ae04c6791f02',
    'a5a891eb-ad2e-497d-8fc2-963be20f07e5',
    '929a62e7-cc55-4ddf-8d37-584e9b67c137',
    '6bcfb39a-f0ff-4615-9ed9-44585c59e2d9',
    '23eae59c-901a-48cf-879f-662bda91dc23',
    '5df4f833-c6c2-4d7f-b46c-1fdbedb9891c',
    '0a4cf5a3-f4c0-47b5-8338-49f69768fe54',
    '445dba43-b918-4552-b7a3-39fe032c2306',
    '098e3fd4-4b7f-4505-99a8-c01de3ae1d4f',
    'e92c1885-5ebb-4289-9bed-52af75ff1e8e',
    'c9a252fc-9f3c-4b3b-9d6a-a31459e9b5fe',
    '4f9e4847-c789-4ce3-99ce-737446ba0794',
    '13125405-580e-4f08-905e-33f41e7e1854',
    '1b8fdad1-3c82-41e7-815c-4e5b7c0fcfff',
    '09b02754-3453-477a-b4c4-6de5ff6129c2',
    '71f9983b-1b7d-4bf0-9788-a9954c60772e',
    'ea0f0681-16d0-4913-a21f-a309d5f3f25d',
    '47120879-61fb-49bf-92f8-64e5695841c0',
    'c648a844-fbac-4f40-ad8f-fcdb56e39c8a',
    '8a2101ca-9fb2-4943-8ab9-f65faee2d86f',
    '6024505c-b099-45a1-85fc-3f324d38ec2e',
    '25e1b1e6-6734-47ee-b907-a9e8c5797314',
    '44c946e6-7315-45df-8069-b24cddf7e976',
    'a96b3159-57f6-4953-ab5a-93f6fa1d4e00',
    '53edc81f-65d4-4894-b832-f2858db8b904',
    'aae87ef4-49e0-4eb5-b760-087d0ea31077',
    '4afa1825-6793-4f9f-8280-5f357c261ace',
    '93dd5d37-74af-4f7b-ac08-4c377960eee1',
    '4d310165-6882-4719-a607-1c038641634b',
    '40fff4f8-e39e-4399-a7ae-dab0f1ce8245',
    '14989ec6-cdd3-4b72-90de-7d18febf4a30',
    '7c96d3fb-e1ff-4f4b-bff5-91d1ba415ec1',
    '4b9bcb65-8788-4f3b-87ac-41a5cf3ec944',
    'fbad1b86-fe16-4c9e-9ef4-77febacb71a0',
    'cd9c95f1-9674-4c1d-a5dd-6361e6300c4a',
    'd8c6a2f1-eeb0-40aa-b857-4f4b16842413',
    'a3803fbe-ddb4-44fa-aa8c-9e251f3708f8',
    '11c798e3-b0ce-4166-95db-e1ebfc890a6f',
    '65bc4bc6-693c-4ed3-8c9c-1fb3396a0a0b',
    'a0424707-f62b-46aa-9f16-8b7602700605',
    '8d45dadc-a3db-4d4a-8c49-d7a4b8fe756d',
    '8a9b3d85-f9c1-41c4-b4a5-34f4b37779b8',
    'b73c43e6-2120-4a74-924c-6e131d0f716a',
    '26932ba1-d84e-4969-a77f-efe1b41e01f6',
    'e13d1df2-e8a8-4a4f-9d9d-b9e9f150251d',
    '81017cf7-7c45-4839-a5e3-84bcb57b596d',
    'ba7e8409-c40f-4330-aaa5-1474ba159dfa',
    '93a5a3fd-7d73-403a-95a8-8b46d5dd34f8',
    'b5df81ef-d310-454d-a420-84cab902e9f1',
    '60771250-ab28-4df6-82cd-4b4d19e5544d',
    '5583ee22-d1b6-4350-a84d-dbb37d8cd2c0',
    'c8887bb5-effb-4ead-884a-94c143fad963'
            ]::uuid[]) loop
    if r.status <> 'deleted' then
      raise exception '8.2: % is % now, not deleted — the plan is stale', r.key, r.status;
    end if;
    -- A shared task's status may change only by an admin or through a
    -- revision step; this is one, row by row.
    perform set_config('qira.revision', r.id::text, true);
    update public.tasks set status = 'archived' where id = r.id;
    insert into public.data_migration_log (block, table_name, row_id, action, before, after)
    values ('8.2', 'tasks', r.id::text, 'deleted_to_archived', jsonb_build_object('key', r.key, 'status', 'deleted'), jsonb_build_object('status', 'archived'));
    insert into public.task_activities (project_id, task_id, actor_id, activity_type, message)
    select project_id, id, null, 'task_updated', 'Moved from the trash to the archive (data migration, stage 8)' from public.tasks where id = r.id;
    v_n := v_n + 1;
  end loop;
  perform set_config('qira.revision', '', true);
  if v_n <> 150 then
    raise exception '8.2: archived % tasks, expected 150', v_n;
  end if;
end;
$$;
