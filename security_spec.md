# CRM Desk Firestore Security Specification (Phase 0)

## 1. Data Invariants
1. **Verified Identity & Admin Gate**: Only users with `request.auth != null && request.auth.token.email_verified == true` may access application resources. Administrative privileges are strictly verified via `/admins/$(request.auth.uid)` or the verified bootstrap admin email (`tanawin.wat@gmail.com`).
2. **No Self-Assigned Roles**: Users creating their own `/users/{userId}` document cannot assign themselves `admin` or `tl` roles unless backed by a verified `/staff_directory/{staffId}` record matching their verified email or the bootstrapped admin email.
3. **PII Isolation**: Staff email addresses reside exclusively in `/staff_directory/{staffId}` (readable only by Admins or the matching verified email owner via single-doc `get`) and `/users/{userId}/private/{docId}` (readable only by the owner or Admin). Operational `/users/{userId}` profiles contain no PII.
4. **Team Scoping for Agents**: Agents may only create, read, and update cases belonging to their assigned `team_id`, and cannot transfer a case to another team or reassign ownership across teams.
5. **Per-User SLA Acknowledgments**: Each user's SLA acknowledgment state in `/users/{userId}/case_acks/{ackId}` is strictly scoped to `userId == request.auth.uid`.
6. **Temporal Integrity & Strict Schema Keys**: Every write validates required/allowed keys (`hasAll` + `hasOnly`), string lengths, regex IDs, and server-side timestamps (`request.time`) for `created_at`/`updated_at`/`ack_at`.
7. **Original Case Immutability for Agent & TL**: After a case is created, Agents and TLs cannot modify original case fields (`case_no`, `shop_id`, `issue_summary`, `details`); only Admins may edit original case details or delete cases.
8. **Internal Note Audit Integrity**: Every edit to `/cases/{caseId}/internal_notes/{noteId}` must atomically create an immutable `/edit_logs/{logId}` record matching exact pre-update (`get()`) and post-update (`getAfter()`) content/SLA values.
9. **Admin-Only Deletion on Cases, Notes & Logs**: Agents and TLs can create and edit Internal Notes (with edit logs) but cannot delete cases, Internal Notes, or edit logs. Only Admins can delete them.
10. **Escalation Atomicity & Recipient Gate**: Only an authorized case viewer can initiate an escalation (`status: 'pending'`), only the designated `to_user_id` can Accept (transferring ownership) or Reject (returning to sender and clearing `pending_escalation_id`), and only the original `from_user_id` can acknowledge a rejection across both `case_escalations` and `escalation_logs`.

## 2. The "Dirty Dozen+" Adversarial Payloads
1. **Unverified Email Admin Spoof**: Sign in with `email: "tanawin.wat@gmail.com"`, `email_verified: false` -> attempt to write `/teams/hack` -> MUST return `PERMISSION_DENIED`.
2. **Self-Role Escalation on User Profile**: Non-admin user attempts `create` on `/users/{uid}` with `role: "admin"` without a matching `/staff_directory` record -> MUST return `PERMISSION_DENIED`.
3. **Shadow / Ghost Field Injection (Create)**: Authenticated user creates `/cases/case_1` with an extra field `isAdminApproved: true` -> MUST return `PERMISSION_DENIED`.
4. **Shadow / Ghost Field Injection (Update)**: Authenticated user updates `/cases/case_1` with `{ status: "done", hiddenFlag: true }` -> MUST return `PERMISSION_DENIED`.
5. **Cross-Team Case Creation (Agent)**: Agent belonging to `team_id: "line_oa"` attempts to create `/cases/case_2` with `team_id: "call"` -> MUST return `PERMISSION_DENIED`.
6. **Cross-Team Case Update (Agent)**: Agent belonging to `team_id: "line_oa"` attempts to update `/cases/case_call_1` (`team_id: "call"`) -> MUST return `PERMISSION_DENIED`.
7. **Unauthorized Team Reassignment (Agent)**: Agent attempts to update `team_id` or `assignee_id` on an existing case -> MUST return `PERMISSION_DENIED`.
8. **PII Scraping on `staff_directory` List**: Non-admin authenticated user attempts `list` on `/staff_directory` -> MUST return `PERMISSION_DENIED`.
9. **PII Cross-User Read on `private`**: Non-admin user attempts `get` on `/users/other_uid/private/info` -> MUST return `PERMISSION_DENIED`.
10. **ID Poisoning**: Authenticated user attempts `create` on `/cases/invalid@id!#` or a 200-char ID -> MUST return `PERMISSION_DENIED`.
11. **Timestamp Tampering**: Authenticated user attempts `create` on `/cases/case_3` with a backdated `created_at` != `request.time` -> MUST return `PERMISSION_DENIED`.
12. **Terminal State / Cross-User Ack Tampering**: Authenticated user A attempts to write `/users/user_b/case_acks/case_1_due_today` to silence user B's SLA popup -> MUST return `PERMISSION_DENIED`.
13. **Original Case Detail Tampering (Agent/TL)**: Agent or TL attempts to alter `issue_summary` or `details` on an existing `/cases/case_1` -> MUST return `PERMISSION_DENIED`.
14. **Silent Internal Note Edit Without Log**: Agent, TL, or Admin attempts to update `/cases/case_1/internal_notes/note_1` without creating the matching `edit_logs/{logId}` document -> MUST return `PERMISSION_DENIED`.
15. **Forged Edit Log Content**: User attempts to create an `edit_logs/{logId}` whose `old_content` does not match the note's pre-edit `content` -> MUST return `PERMISSION_DENIED`.
16. **Unauthorized Deletion (Agent/TL)**: Agent or TL attempts to delete `/cases/case_1`, `/cases/case_1/internal_notes/note_1`, or any `edit_logs` doc -> MUST return `PERMISSION_DENIED`.
17. **Unauthorized Escalation Hijack**: User C attempts to Accept or Reject a pending `/case_escalations/esc_1` addressed to User B -> MUST return `PERMISSION_DENIED`.
18. **Forged Rejection Acknowledgment**: Non-sender User C attempts to set `sender_ack_done: true` on a rejected escalation -> MUST return `PERMISSION_DENIED`.
