🚀   Release Notes – Version 1.18
Release Date: October 13, 2026
✨ New Features & Improvements
Administrator:
Role Permission Matrix: Added a visual permission matrix to the role management page, showing at a glance which capabilities each role holds and allowing bulk edits with immediate effect.
Audit Log Export: Administrators can now export filtered audit log entries as CSV for compliance reviews and offline analysis.
Member:
Profile Self-Service: Members can update their own profile details and upload a profile picture without contacting support, with changes reflected instantly across the workspace.
Saved Views: Personal saved views for the main list pages let members store their preferred filters and column layouts and switch between them with one click.
Manager:
Assignment Templates: Managers can create reusable assignment templates and apply them to new work items in a single action, cutting setup time for recurring workflows.
Team Dashboard: A new dashboard summarizing workload, upcoming deadlines, and recent activity is available for every team, with drill-down into individual items.
Bulk Import: The import wizard now validates files before committing them, reporting row-level problems with clear messages before anything is saved.
🐞 Bug Fixes
Fixed an issue where notifications were sent with incorrect timestamps for users in time zones with half-hour offsets.
Fixed a rare case where deleting an item that another user had open could leave the list view stale until a manual refresh.
Fixed the export dialog ignoring the selected date range when the "include archived" option was active.
♻️ Improvement
Faster list loading on large workspaces thanks to paginated queries and slimmer default columns.
Keyboard navigation now works across all dialogs, and focus is restored to the triggering button on close.
The guided tour has been rewritten to match the current UI and can be replayed at any time from the help menu.
🔥 Hotfixes
Login failures for users with email addresses containing plus signs — sign-in now works again for all address formats.
The nightly report job skipped workspaces with more than 10,000 entries; all scheduled reports are delivered in full again.
