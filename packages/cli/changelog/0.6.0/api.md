# 🔌 API Changes v0.6.0

## Add live OpenAI coverage reporting to CLI

PR: [#2103](https://github.com/tetherto/qvac/pull/2103)

```bash
# Full report (live spec fetch, cached under ~/.cache/qvac/)
qvac openai coverage

# Filters
qvac openai coverage --primary-ai          # spec inference surface
qvac openai coverage --consumer-primary    # consumer-demanded endpoints
qvac openai coverage --unsupported
qvac openai coverage --unknown             # unmapped spec labels only
qvac openai coverage --json
qvac openai coverage --offline               # use cached spec only
```

```
qvac serve openai — coverage

Spec: /Users/lauri/.cache/qvac/openai-spec.yaml (offline cache) (242 endpoints)
Router: /Users/lauri/noxtton/qvac/packages/cli/src/serve/adapters/openai/index.ts (25 implemented)

Coverage by category:
  primary-ai      12 /  46   ( 26.1%)
  ai-secondary    13 /  24   ( 54.2%)
  platform         0 / 172   (  0.0%)

Primary AI surface (consumer-demanded): 7 / 12 (58.3%)

Endpoints:
  [x] POST /v1/audio/speech                         primary-ai     (Audio, audio)
      caveat: response is raw audio bytes (wav/pcm/etc.)
  [x] POST /v1/audio/transcriptions                 primary-ai     (Audio, audio)
  [x] POST /v1/chat/completions                     primary-ai     (Chat, chat)
  [x] POST /v1/embeddings                           primary-ai     (Embeddings, embeddings)
  [x] POST /v1/images/edits                         primary-ai     (Images, images)
      caveat: response_format=url requires --public-base-url on the server
  [x] POST /v1/images/generations                   primary-ai     (Images, images)
      caveat: response_format=url requires --public-base-url on the server
  [ ] POST /v1/realtime/client_secrets              primary-ai     (Realtime, realtime)
  [ ] POST /v1/realtime/sessions                    primary-ai     (Realtime, realtime)
  [ ] POST /v1/realtime/transcription_sessions      primary-ai     (Realtime, realtime)
  [x] POST /v1/responses                            primary-ai     (Responses, responses)
      caveat: in-memory store for retrieve/delete/input_items; not durable across restarts
  [ ] POST /v1/videos                               primary-ai     (Videos, videos)
  [ ] POST /v1/videos/edits                         primary-ai     (Videos)
```

```
qvac serve openai — coverage

Spec: /Users/lauri/.cache/qvac/openai-spec.yaml (offline cache) (242 endpoints)
Router: /Users/lauri/noxtton/qvac/packages/cli/src/serve/adapters/openai/index.ts (25 implemented)

Coverage by category:
  primary-ai      12 /  46   ( 26.1%)
  ai-secondary    13 /  24   ( 54.2%)
  platform         0 / 172   (  0.0%)

Primary AI surface (consumer-demanded): 7 / 12 (58.3%)

Endpoints:
  [ ] GET /v1/assistants                            platform     (Assistants, assistants)
      caveat: deprecated in upstream spec
  [ ] POST /v1/assistants                           platform     (Assistants, assistants)
      caveat: deprecated in upstream spec
  [ ] DELETE /v1/assistants/{assistant_id}          platform     (Assistants, assistants)
      caveat: deprecated in upstream spec
  [ ] GET /v1/assistants/{assistant_id}             platform     (Assistants, assistants)
      caveat: deprecated in upstream spec
  [ ] POST /v1/assistants/{assistant_id}            platform     (Assistants, assistants)
      caveat: deprecated in upstream spec
  [x] POST /v1/audio/speech                         primary-ai     (Audio, audio)
      caveat: response is raw audio bytes (wav/pcm/etc.)
  [x] POST /v1/audio/transcriptions                 primary-ai     (Audio, audio)
  [x] POST /v1/audio/translations                   primary-ai     (Audio, audio)
  [ ] GET /v1/audio/voice_consents                  primary-ai     (Audio, audio)
  [ ] POST /v1/audio/voice_consents                 primary-ai     (Audio, audio)
  [ ] DELETE /v1/audio/voice_consents/{consent_id}  primary-ai     (Audio, audio)
  [ ] GET /v1/audio/voice_consents/{consent_id}     primary-ai     (Audio, audio)
  [ ] POST /v1/audio/voice_consents/{consent_id}    primary-ai     (Audio, audio)
  [ ] POST /v1/audio/voices                         primary-ai     (Audio, audio)
  [ ] GET /v1/batches                               platform     (Batch, batch)
  [ ] POST /v1/batches                              platform     (Batch, batch)
  [ ] GET /v1/batches/{batch_id}                    platform     (Batch, batch)
  [ ] POST /v1/batches/{batch_id}/cancel            platform     (Batch, batch)
  [ ] GET /v1/chat/completions                      primary-ai     (Chat, chat)
  [x] POST /v1/chat/completions                     primary-ai     (Chat, chat)
  [ ] DELETE /v1/chat/completions/{completion_id}   primary-ai     (Chat, chat)
  [ ] GET /v1/chat/completions/{completion_id}      primary-ai     (Chat, chat)
  [ ] POST /v1/chat/completions/{completion_id}     primary-ai     (Chat, chat)
  [ ] GET /v1/chat/completions/{completion_id}/messagesprimary-ai     (Chat, chat)
  [ ] POST /v1/chatkit/sessions                     platform     (chatkit)
  [ ] POST /v1/chatkit/sessions/{session_id}/cancel platform     (chatkit)
  [ ] GET /v1/chatkit/threads                       platform     (chatkit)
  [ ] DELETE /v1/chatkit/threads/{thread_id}        platform     (chatkit)
  [ ] GET /v1/chatkit/threads/{thread_id}           platform     (chatkit)
  [ ] GET /v1/chatkit/threads/{thread_id}/items     platform     (chatkit)
  [x] POST /v1/completions                          primary-ai     (Completions, completions)
  [ ] GET /v1/containers                            platform     (containers)
  [ ] POST /v1/containers                           platform     (containers)
  [ ] DELETE /v1/containers/{container_id}          platform     (containers)
  [ ] GET /v1/containers/{container_id}             platform     (containers)
  [ ] GET /v1/containers/{container_id}/files       platform     (containers)
  [ ] POST /v1/containers/{container_id}/files      platform     (containers)
  [ ] DELETE /v1/containers/{container_id}/files/{file_id}platform     (containers)
  [ ] GET /v1/containers/{container_id}/files/{file_id}platform     (containers)
  [ ] GET /v1/containers/{container_id}/files/{file_id}/contentplatform     (containers)
  [ ] POST /v1/conversations                        platform     (Conversations, conversations)
  [ ] DELETE /v1/conversations/{conversation_id}    platform     (Conversations, conversations)
  [ ] GET /v1/conversations/{conversation_id}       platform     (Conversations, conversations)
  [ ] POST /v1/conversations/{conversation_id}      platform     (Conversations, conversations)
  [ ] GET /v1/conversations/{conversation_id}/items platform     (Conversations, conversations)
  [ ] POST /v1/conversations/{conversation_id}/itemsplatform     (Conversations, conversations)
  [ ] DELETE /v1/conversations/{conversation_id}/items/{item_id}platform     (Conversations, conversations)
  [ ] GET /v1/conversations/{conversation_id}/items/{item_id}platform     (Conversations, conversations)
  [x] POST /v1/embeddings                           primary-ai     (Embeddings, embeddings)
  [ ] GET /v1/evals                                 platform     (Evals, evals)
  [ ] POST /v1/evals                                platform     (Evals, evals)
  [ ] DELETE /v1/evals/{eval_id}                    platform     (Evals, evals)
  [ ] GET /v1/evals/{eval_id}                       platform     (Evals, evals)
  [ ] POST /v1/evals/{eval_id}                      platform     (Evals, evals)
  [ ] GET /v1/evals/{eval_id}/runs                  platform     (Evals, evals)
  [ ] POST /v1/evals/{eval_id}/runs                 platform     (Evals, evals)
  [ ] DELETE /v1/evals/{eval_id}/runs/{run_id}      platform     (Evals, evals)
  [ ] GET /v1/evals/{eval_id}/runs/{run_id}         platform     (Evals, evals)
  [ ] POST /v1/evals/{eval_id}/runs/{run_id}        platform     (Evals, evals)
  [ ] GET /v1/evals/{eval_id}/runs/{run_id}/output_itemsplatform     (Evals, evals)
  [ ] GET /v1/evals/{eval_id}/runs/{run_id}/output_items/{output_item_id}platform     (Evals, evals)
  [x] GET /v1/files                                 ai-secondary     (Files, files)
      caveat: ephemeral in-memory store
  [x] POST /v1/files                                ai-secondary     (Files, files)
      caveat: ephemeral in-memory store
  [ ] DELETE /v1/files/{file_id}                    ai-secondary     (Files, files)
  [x] GET /v1/files/{file_id}                       ai-secondary     (Files, files)
      caveat: ephemeral in-memory store
  [ ] GET /v1/files/{file_id}/content               ai-secondary     (Files, files)
      caveat: ephemeral in-memory store
  [ ] POST /v1/fine_tuning/alpha/graders/run        platform     (Fine-tuning, graders)
  [ ] POST /v1/fine_tuning/alpha/graders/validate   platform     (Fine-tuning, graders)
  [ ] GET /v1/fine_tuning/checkpoints/{fine_tuned_model_checkpoint}/permissionsplatform     (Fine-tuning, fine-tuning)
  [ ] POST /v1/fine_tuning/checkpoints/{fine_tuned_model_checkpoint}/permissionsplatform     (Fine-tuning, fine-tuning)
  [ ] DELETE /v1/fine_tuning/checkpoints/{fine_tuned_model_checkpoint}/permissions/{permission_id}platform     (Fine-tuning, fine-tuning)
  [ ] GET /v1/fine_tuning/jobs                      platform     (Fine-tuning, fine-tuning)
  [ ] POST /v1/fine_tuning/jobs                     platform     (Fine-tuning, fine-tuning)
  [ ] GET /v1/fine_tuning/jobs/{fine_tuning_job_id} platform     (Fine-tuning, fine-tuning)
  [ ] POST /v1/fine_tuning/jobs/{fine_tuning_job_id}/cancelplatform     (Fine-tuning, fine-tuning)
  [ ] GET /v1/fine_tuning/jobs/{fine_tuning_job_id}/checkpointsplatform     (Fine-tuning, fine-tuning)
  [ ] GET /v1/fine_tuning/jobs/{fine_tuning_job_id}/eventsplatform     (Fine-tuning, fine-tuning)
  [ ] POST /v1/fine_tuning/jobs/{fine_tuning_job_id}/pauseplatform     (Fine-tuning, fine-tuning)
  [ ] POST /v1/fine_tuning/jobs/{fine_tuning_job_id}/resumeplatform     (Fine-tuning, fine-tuning)
  [x] POST /v1/images/edits                         primary-ai     (Images, images)
      caveat: response_format=url requires --public-base-url on the server
  [x] POST /v1/images/generations                   primary-ai     (Images, images)
      caveat: response_format=url requires --public-base-url on the server
  [ ] POST /v1/images/variations                    primary-ai     (Images, images)
  [x] GET /v1/models                                ai-secondary     (Models, models)
  [x] DELETE /v1/models/{model}                     ai-secondary     (Models, models)
  [x] GET /v1/models/{model}                        ai-secondary     (Models, models)
  [ ] POST /v1/moderations                          platform     (Moderations, moderations)
  [ ] GET /v1/organization/admin_api_keys           platform     (administration)
  [ ] POST /v1/organization/admin_api_keys          platform     (administration)
  [ ] DELETE /v1/organization/admin_api_keys/{key_id}platform     (administration)
  [ ] GET /v1/organization/admin_api_keys/{key_id}  platform     (administration)
  [ ] GET /v1/organization/audit_logs               platform     (Audit Logs, audit-logs)
  [ ] GET /v1/organization/certificates             platform     (Certificates, administration)
  [ ] POST /v1/organization/certificates            platform     (Certificates, administration)
  [ ] DELETE /v1/organization/certificates/{certificate_id}platform     (Certificates, administration)
  [ ] GET /v1/organization/certificates/{certificate_id}platform     (Certificates, administration)
  [ ] POST /v1/organization/certificates/{certificate_id}platform     (Certificates, administration)
  [ ] POST /v1/organization/certificates/activate   platform     (Certificates, administration)
  [ ] POST /v1/organization/certificates/deactivate platform     (Certificates, administration)
  [ ] GET /v1/organization/costs                    platform     (Usage, usage-costs)
  [ ] GET /v1/organization/groups                   platform     (Groups, administration)
  [ ] POST /v1/organization/groups                  platform     (Groups, administration)
  [ ] DELETE /v1/organization/groups/{group_id}     platform     (Groups, administration)
  [ ] POST /v1/organization/groups/{group_id}       platform     (Groups, administration)
  [ ] GET /v1/organization/groups/{group_id}/roles  platform     (Group organization role assignments, administration)
  [ ] POST /v1/organization/groups/{group_id}/roles platform     (Group organization role assignments, administration)
  [ ] DELETE /v1/organization/groups/{group_id}/roles/{role_id}platform     (Group organization role assignments, administration)
  [ ] GET /v1/organization/groups/{group_id}/users  platform     (Group users, administration)
  [ ] POST /v1/organization/groups/{group_id}/users platform     (Group users, administration)
  [ ] DELETE /v1/organization/groups/{group_id}/users/{user_id}platform     (Group users, administration)
  [ ] GET /v1/organization/invites                  platform     (Invites, administration)
  [ ] POST /v1/organization/invites                 platform     (Invites, administration)
  [ ] DELETE /v1/organization/invites/{invite_id}   platform     (Invites, administration)
  [ ] GET /v1/organization/invites/{invite_id}      platform     (Invites, administration)
  [ ] GET /v1/organization/projects                 platform     (Projects, administration)
  [ ] POST /v1/organization/projects                platform     (Projects, administration)
  [ ] GET /v1/organization/projects/{project_id}    platform     (Projects, administration)
  [ ] POST /v1/organization/projects/{project_id}   platform     (Projects, administration)
  [ ] GET /v1/organization/projects/{project_id}/api_keysplatform     (Projects, administration)
  [ ] DELETE /v1/organization/projects/{project_id}/api_keys/{api_key_id}platform     (Projects, administration)
  [ ] GET /v1/organization/projects/{project_id}/api_keys/{api_key_id}platform     (Projects, administration)
  [ ] POST /v1/organization/projects/{project_id}/archiveplatform     (Projects, administration)
  [ ] GET /v1/organization/projects/{project_id}/certificatesplatform     (Certificates, administration)
  [ ] POST /v1/organization/projects/{project_id}/certificates/activateplatform     (Certificates, administration)
  [ ] POST /v1/organization/projects/{project_id}/certificates/deactivateplatform     (Certificates, administration)
  [ ] GET /v1/organization/projects/{project_id}/groupsplatform     (Project groups, administration)
  [ ] POST /v1/organization/projects/{project_id}/groupsplatform     (Project groups, administration)
  [ ] DELETE /v1/organization/projects/{project_id}/groups/{group_id}platform     (Project groups, administration)
  [ ] GET /v1/organization/projects/{project_id}/rate_limitsplatform     (Projects, administration)
  [ ] POST /v1/organization/projects/{project_id}/rate_limits/{rate_limit_id}platform     (Projects, administration)
  [ ] GET /v1/organization/projects/{project_id}/service_accountsplatform     (Projects, administration)
  [ ] POST /v1/organization/projects/{project_id}/service_accountsplatform     (Projects, administration)
  [ ] DELETE /v1/organization/projects/{project_id}/service_accounts/{service_account_id}platform     (Projects, administration)
  [ ] GET /v1/organization/projects/{project_id}/service_accounts/{service_account_id}platform     (Projects, administration)
  [ ] GET /v1/organization/projects/{project_id}/usersplatform     (Projects, administration)
  [ ] POST /v1/organization/projects/{project_id}/usersplatform     (Projects, administration)
  [ ] DELETE /v1/organization/projects/{project_id}/users/{user_id}platform     (Projects, administration)
  [ ] GET /v1/organization/projects/{project_id}/users/{user_id}platform     (Projects, administration)
  [ ] POST /v1/organization/projects/{project_id}/users/{user_id}platform     (Projects, administration)
  [ ] GET /v1/organization/roles                    platform     (Roles, administration)
  [ ] POST /v1/organization/roles                   platform     (Roles, administration)
  [ ] DELETE /v1/organization/roles/{role_id}       platform     (Roles, administration)
  [ ] POST /v1/organization/roles/{role_id}         platform     (Roles, administration)
  [ ] GET /v1/organization/usage/audio_speeches     platform     (Usage, usage-audio-speeches)
  [ ] GET /v1/organization/usage/audio_transcriptionsplatform     (Usage, usage-audio-transcriptions)
  [ ] GET /v1/organization/usage/code_interpreter_sessionsplatform     (Usage, usage-code-interpreter-sessions)
  [ ] GET /v1/organization/usage/completions        platform     (Usage, usage-completions)
  [ ] GET /v1/organization/usage/embeddings         platform     (Usage, usage-embeddings)
  [ ] GET /v1/organization/usage/images             platform     (Usage, usage-images)
  [ ] GET /v1/organization/usage/moderations        platform     (Usage, usage-moderations)
  [ ] GET /v1/organization/usage/vector_stores      platform     (Usage, usage-vector-stores)
  [ ] GET /v1/organization/users                    platform     (Users, administration)
  [ ] DELETE /v1/organization/users/{user_id}       platform     (Users, administration)
  [ ] GET /v1/organization/users/{user_id}          platform     (Users, administration)
  [ ] POST /v1/organization/users/{user_id}         platform     (Users, administration)
  [ ] GET /v1/organization/users/{user_id}/roles    platform     (User organization role assignments, administration)
  [ ] POST /v1/organization/users/{user_id}/roles   platform     (User organization role assignments, administration)
  [ ] DELETE /v1/organization/users/{user_id}/roles/{role_id}platform     (User organization role assignments, administration)
  [ ] GET /v1/projects/{project_id}/groups/{group_id}/rolesplatform     (Project group role assignments, administration)
  [ ] POST /v1/projects/{project_id}/groups/{group_id}/rolesplatform     (Project group role assignments, administration)
  [ ] DELETE /v1/projects/{project_id}/groups/{group_id}/roles/{role_id}platform     (Project group role assignments, administration)
  [ ] GET /v1/projects/{project_id}/roles           platform     (Roles, administration)
  [ ] POST /v1/projects/{project_id}/roles          platform     (Roles, administration)
  [ ] DELETE /v1/projects/{project_id}/roles/{role_id}platform     (Roles, administration)
  [ ] POST /v1/projects/{project_id}/roles/{role_id}platform     (Roles, administration)
  [ ] GET /v1/projects/{project_id}/users/{user_id}/rolesplatform     (Project user role assignments, administration)
  [ ] POST /v1/projects/{project_id}/users/{user_id}/rolesplatform     (Project user role assignments, administration)
  [ ] DELETE /v1/projects/{project_id}/users/{user_id}/roles/{role_id}platform     (Project user role assignments, administration)
  [ ] POST /v1/realtime/calls                       primary-ai     (Realtime, realtime)
  [ ] POST /v1/realtime/calls/{call_id}/accept      primary-ai     (Realtime, realtime-calls)
  [ ] POST /v1/realtime/calls/{call_id}/hangup      primary-ai     (Realtime, realtime-calls)
  [ ] POST /v1/realtime/calls/{call_id}/refer       primary-ai     (Realtime, realtime-calls)
  [ ] POST /v1/realtime/calls/{call_id}/reject      primary-ai     (Realtime, realtime-calls)
  [ ] POST /v1/realtime/client_secrets              primary-ai     (Realtime, realtime)
  [ ] POST /v1/realtime/sessions                    primary-ai     (Realtime, realtime)
  [ ] POST /v1/realtime/transcription_sessions      primary-ai     (Realtime, realtime)
  [ ] POST /v1/realtime/translations/client_secrets primary-ai     (Realtime, realtime)
  [x] POST /v1/responses                            primary-ai     (Responses, responses)
      caveat: in-memory store for retrieve/delete/input_items; not durable across restarts
  [x] DELETE /v1/responses/{response_id}            primary-ai     (Responses, responses)
      caveat: in-memory only
      caveat: X-QVAC-Stub: responses-volatile
  [x] GET /v1/responses/{response_id}               primary-ai     (Responses, responses)
      caveat: in-memory only
      caveat: X-QVAC-Stub: responses-volatile
  [ ] POST /v1/responses/{response_id}/cancel       primary-ai     (Responses, responses)
  [x] GET /v1/responses/{response_id}/input_items   primary-ai     (Responses, responses)
      caveat: in-memory only
      caveat: X-QVAC-Stub: responses-volatile
  [ ] POST /v1/responses/compact                    primary-ai     (responses)
  [ ] POST /v1/responses/input_tokens               primary-ai     (responses)
  [ ] GET /v1/skills                                platform     (Skills)
  [ ] POST /v1/skills                               platform     (Skills)
  [ ] DELETE /v1/skills/{skill_id}                  platform     (Skills)
  [ ] GET /v1/skills/{skill_id}                     platform     (Skills)
  [ ] POST /v1/skills/{skill_id}                    platform     (Skills)
  [ ] GET /v1/skills/{skill_id}/content             platform     (Skills)
  [ ] GET /v1/skills/{skill_id}/versions            platform     (Skills)
  [ ] POST /v1/skills/{skill_id}/versions           platform     (Skills)
  [ ] DELETE /v1/skills/{skill_id}/versions/{version}platform     (Skills)
  [ ] GET /v1/skills/{skill_id}/versions/{version}  platform     (Skills)
  [ ] GET /v1/skills/{skill_id}/versions/{version}/contentplatform     (Skills)
  [ ] POST /v1/threads                              platform     (Assistants, threads)
  [ ] DELETE /v1/threads/{thread_id}                platform     (Assistants, threads)
  [ ] GET /v1/threads/{thread_id}                   platform     (Assistants, threads)
  [ ] POST /v1/threads/{thread_id}                  platform     (Assistants, threads)
  [ ] GET /v1/threads/{thread_id}/messages          platform     (Assistants, threads)
  [ ] POST /v1/threads/{thread_id}/messages         platform     (Assistants, threads)
  [ ] DELETE /v1/threads/{thread_id}/messages/{message_id}platform     (Assistants, threads)
  [ ] GET /v1/threads/{thread_id}/messages/{message_id}platform     (Assistants, threads)
  [ ] POST /v1/threads/{thread_id}/messages/{message_id}platform     (Assistants, threads)
  [ ] GET /v1/threads/{thread_id}/runs              platform     (Assistants, threads)
  [ ] POST /v1/threads/{thread_id}/runs             platform     (Assistants, threads)
  [ ] GET /v1/threads/{thread_id}/runs/{run_id}     platform     (Assistants, threads)
  [ ] POST /v1/threads/{thread_id}/runs/{run_id}    platform     (Assistants, threads)
  [ ] POST /v1/threads/{thread_id}/runs/{run_id}/cancelplatform     (Assistants, threads)
  [ ] GET /v1/threads/{thread_id}/runs/{run_id}/stepsplatform     (Assistants, threads)
  [ ] GET /v1/threads/{thread_id}/runs/{run_id}/steps/{step_id}platform     (Assistants, threads)
  [ ] POST /v1/threads/{thread_id}/runs/{run_id}/submit_tool_outputsplatform     (Assistants, threads)
  [ ] POST /v1/threads/runs                         platform     (Assistants, threads)
  [ ] POST /v1/uploads                              platform     (Uploads, uploads)
  [ ] POST /v1/uploads/{upload_id}/cancel           platform     (Uploads, uploads)
  [ ] POST /v1/uploads/{upload_id}/complete         platform     (Uploads, uploads)
  [ ] POST /v1/uploads/{upload_id}/parts            platform     (Uploads, uploads)
  [x] GET /v1/vector_stores                         ai-secondary     (Vector stores, vector_stores)
      caveat: in-memory metadata; survives process lifetime only
  [x] POST /v1/vector_stores                        ai-secondary     (Vector stores, vector_stores)
      caveat: in-memory metadata; survives process lifetime only
  [x] DELETE /v1/vector_stores/{vector_store_id}    ai-secondary     (Vector stores, vector_stores)
      caveat: in-memory metadata; survives process lifetime only
  [x] GET /v1/vector_stores/{vector_store_id}       ai-secondary     (Vector stores, vector_stores)
      caveat: in-memory metadata; survives process lifetime only
  [x] POST /v1/vector_stores/{vector_store_id}      ai-secondary     (Vector stores, vector_stores)
      caveat: in-memory metadata; survives process lifetime only
  [ ] POST /v1/vector_stores/{vector_store_id}/file_batchesai-secondary     (Vector stores, vector_stores)
  [ ] GET /v1/vector_stores/{vector_store_id}/file_batches/{batch_id}ai-secondary     (Vector stores, vector_stores)
  [ ] POST /v1/vector_stores/{vector_store_id}/file_batches/{batch_id}/cancelai-secondary     (Vector stores, vector_stores)
  [ ] GET /v1/vector_stores/{vector_store_id}/file_batches/{batch_id}/filesai-secondary     (Vector stores, vector_stores)
  [ ] GET /v1/vector_stores/{vector_store_id}/files ai-secondary     (Vector stores, vector_stores)
  [x] POST /v1/vector_stores/{vector_store_id}/filesai-secondary     (Vector stores, vector_stores)
      caveat: in-memory metadata; survives process lifetime only
  [ ] DELETE /v1/vector_stores/{vector_store_id}/files/{file_id}ai-secondary     (Vector stores, vector_stores)
  [ ] GET /v1/vector_stores/{vector_store_id}/files/{file_id}ai-secondary     (Vector stores, vector_stores)
  [ ] POST /v1/vector_stores/{vector_store_id}/files/{file_id}ai-secondary     (Vector stores, vector_stores)
  [ ] GET /v1/vector_stores/{vector_store_id}/files/{file_id}/contentai-secondary     (Vector stores, vector_stores)
  [x] POST /v1/vector_stores/{vector_store_id}/searchai-secondary     (Vector stores, vector_stores)
      caveat: in-memory metadata; survives process lifetime only
  [ ] GET /v1/videos                                primary-ai     (Videos, videos)
  [ ] POST /v1/videos                               primary-ai     (Videos, videos)
  [ ] DELETE /v1/videos/{video_id}                  primary-ai     (Videos, videos)
  [ ] GET /v1/videos/{video_id}                     primary-ai     (Videos, videos)
  [ ] GET /v1/videos/{video_id}/content             primary-ai     (Videos, videos)
  [ ] POST /v1/videos/{video_id}/remix              primary-ai     (Videos, videos)
  [ ] POST /v1/videos/characters                    primary-ai     (Videos)
  [ ] GET /v1/videos/characters/{character_id}      primary-ai     (Videos)
  [ ] POST /v1/videos/edits                         primary-ai     (Videos)
  [ ] POST /v1/videos/extensions                    primary-ai     (Videos)
```

---

## Resolve SDK from hoisted node_modules in cli bundler

PR: [#2140](https://github.com/tetherto/qvac/pull/2140)

```bash
$ cd apps/mobile           # @qvac/sdk hoisted to ../../node_modules/@qvac/sdk
$ qvac bundle sdk
❌ Bundle Error: bare-imports.json not found at .../node_modules/@qvac/sdk/...
```

```bash
$ cd apps/mobile
$ qvac bundle sdk
✅ Bundle generated successfully
```

```bash
$ qvac bundle sdk
❌ SDK Error: @qvac/sdk not found in any ancestor node_modules from <projectRoot>.
   Run `bun install` (or `npm install`) at your project root, or pass `--sdk-path <path>`.
```

---

## Add OpenAI-compatible /v1/videos (txt2vid, async)

PR: [#2367](https://github.com/tetherto/qvac/pull/2367)

```json
{
  "serve": {
    "models": {
      "wan-t2v": {
        "src": "WAN2_1_T2V_1_3B_FP16",
        "type": "sdcpp-video",
        "preload": true,
        "config": {
          "t5XxlModelSrc": "UMT5_XXL_FP16",
          "vaeModelSrc": "WAN_2_1_COMFYUI_REPACKAGED_VAE",
          "diffusion_fa": true,
          "offload_to_cpu": true,
          "vae_on_cpu": true,
          "vae_tiling": true
        }
      }
    }
  }
}
```

```bash
#!/usr/bin/env bash
# Usage:
#   ./run.sh          # quick: 416x240, 5 frames, 1 step  (~30 s)
#   ./run.sh real     # real:  480x832, 33 frames, 30 steps, flow_shift=3.0
set -euo pipefail

MODE="${1:-quick}"
case "${MODE}" in quick|real) ;; *) echo "usage: $0 [quick|real]" >&2; exit 2 ;; esac

CLI_DIR="$(git rev-parse --show-toplevel)/packages/cli"
E2E_DIR="$(dirname "$0")"
OUT_DIR="${E2E_DIR}/out"
CONFIG="${E2E_DIR}/qvac.config.json"
LOG_FILE="${E2E_DIR}/server.log"
PORT="${PORT:-11434}"
BASE_URL="http://127.0.0.1:${PORT}"
mkdir -p "${OUT_DIR}"

# build if dist/ is stale
if [[ ! -f "${CLI_DIR}/dist/index.js" ]] \
    || [[ "${CLI_DIR}/src/serve/routes/videos.ts" -nt "${CLI_DIR}/dist/serve/routes/videos.js" ]]; then
  ( cd "${CLI_DIR}" && npm run build )
fi

# spawn server
SERVER_PID=""
trap '[[ -n "${SERVER_PID}" ]] && kill "${SERVER_PID}" 2>/dev/null; wait "${SERVER_PID}" 2>/dev/null || true' EXIT INT TERM
node "${CLI_DIR}/dist/index.js" serve openai --config "${CONFIG}" --port "${PORT}" --verbose \
    > "${LOG_FILE}" 2>&1 &
SERVER_PID=$!

# wait for readiness (first run downloads Wan weights via the P2P registry — minutes)
for _ in {1..900}; do
  curl -fsS --max-time 1 "${BASE_URL}/openapi.json" >/dev/null 2>&1 && break
  kill -0 "${SERVER_PID}" 2>/dev/null || { tail -40 "${LOG_FILE}"; exit 5; }
  sleep 1
done

# parameters per mode
if [[ "${MODE}" = real ]]; then
  POST_BODY='{ "model": "wan-t2v", "prompt": "a colorful bird flapping its wings in a sunny garden",
    "negative_prompt": "blurry, low quality, static, jittery, watermark",
    "size": "480x832", "seconds": "2", "fps": 16, "steps": 30,
    "cfg_scale": 6.0, "flow_shift": 3.0, "seed": 42 }'
else
  POST_BODY='{ "model": "wan-t2v", "prompt": "a red ball bouncing on a white floor",
    "size": "416x240", "seconds": "1", "fps": 16, "steps": 1, "seed": 42 }'
fi

# POST → poll → fetch (default mp4, then avi, then mp4 explicit) → DELETE
ID=$(curl -fsS -X POST "${BASE_URL}/v1/videos" -H 'content-type: application/json' -d "${POST_BODY}" \
       | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
while :; do
  STATUS=$(curl -fsS "${BASE_URL}/v1/videos/${ID}" \
             | python3 -c 'import json,sys; o=json.load(sys.stdin); print(o["status"], o["progress"])')
  echo "  ${STATUS}"
  case "${STATUS%% *}" in completed) break ;; failed) exit 6 ;; esac
  sleep 5
done

curl -fsS "${BASE_URL}/v1/videos/${ID}/content"             -o "${OUT_DIR}/${ID}.bin"
curl -fsS "${BASE_URL}/v1/videos/${ID}/content?format=avi"  -o "${OUT_DIR}/${ID}.avi"
command -v ffmpeg >/dev/null 2>&1 && curl -fsS "${BASE_URL}/v1/videos/${ID}/content?format=mp4" -o "${OUT_DIR}/${ID}.mp4"
curl -fsS -X DELETE "${BASE_URL}/v1/videos/${ID}" | python3 -m json.tool
```

```http
POST /v1/videos
Content-Type: application/json

{
  "model": "wan-t2v",
  "prompt": "a colorful bird flapping its wings",
  "size": "480x832",
  "seconds": "2",
  "fps": 16,
  "steps": 30,
  "cfg_scale": 6.0,
  "flow_shift": 3.0,
  "negative_prompt": "blurry, low quality, static",
  "seed": 42
}

→ 200
{
  "id": "video_8f3a…",
  "object": "video",
  "model": "wan-t2v",
  "status": "queued",
  "progress": 0,
  "created_at": 1748800000,
  "completed_at": null,
  "expires_at": 253402300799,
  "prompt": "a colorful bird flapping its wings",
  "size": "480x832",
  "seconds": "2",
  "remixed_from_video_id": null,
  "error": null
}
```

```json
{
  "serve": {
    "models": {
      "wan-t2v": {
        "src": "WAN2_1_T2V_1_3B_FP16",
        "type": "sdcpp-video",
        "preload": true,
        "config": {
          "t5XxlModelSrc": "UMT5_XXL_FP16",
          "vaeModelSrc": "WAN_2_1_COMFYUI_REPACKAGED_VAE",
          "offload_to_cpu": true
        }
      }
    }
  }
}
```

---

