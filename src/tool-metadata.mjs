// MCP annotations describe effects; they do not grant action authority.
const READ = new Set([
  'portal_state', 'portal_snapshot', 'portal_remote_status', 'os_list_apps',
  'os_find_window', 'os_focused_window', 'vision_find_text', 'os_ax_check',
  'os_ax_targets', 'os_ax_snapshot', 'os_screenshot_image',
]);
const NON_DESTRUCTIVE = new Set([
  'portal_remote_begin', 'portal_remote_release', 'os_ax_enroll', 'os_ax_release',
]);
export function withToolMetadata(tool) {
  const title = tool.name.split('_').map(s => s[0].toUpperCase() + s.slice(1)).join(' ');
  return { ...tool, title, annotations: {
    title,
    readOnlyHint: READ.has(tool.name),
    destructiveHint: !READ.has(tool.name) && !NON_DESTRUCTIVE.has(tool.name),
    openWorldHint: true,
  } };
}
