For each node you fetch, save to `{{mcpDir}}`:
- `<screen-name>.layers.md`: a trimmed, CSS-like layer dump. Include the hierarchy, sizes, auto-layout direction/padding/gap, colours, typography, borders and radius, and component names. Collapse repeated siblings ("table row × 20"). Leave out invisible layers.
- Append every visible text string for that screen, word for word, to `copy.md` under a heading with the screen name.

These files are the cache: later steps and the reviewer read them. Never fetch a node that is already saved.
