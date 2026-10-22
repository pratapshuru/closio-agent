Fetch the design through the Figma MCP tools. Do it once, during planning.

For each link above, call `get_design_context` for that node (the node id is shown next to the link; the URL form 1455-398825 becomes 1455:398825). Call `get_screenshot` to see it. If a link points at a section with several screens, fetch only the screens this ticket needs.

{{saveRules}}

While coding, fetch an extra component only when you need detail that is not saved yet, and save it the same way.

Set `design_status` to "figma_mcp" when the fetch worked. If a Figma call fails (not authorised, rate limit, not found), stop calling Figma and set `design_status` to "unavailable" instead.
