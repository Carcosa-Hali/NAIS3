# Spreadsheet fragments and shared variables

Two prompt features that work together. Both are applied per generated image, in every prompt field
(main prompt, main negative, each character prompt, each character negative).

## Spreadsheet fragments (`<Sheet/Key>`)

Settings → Storage → **Spreadsheet fragments (.xlsx)** selects one workbook (.xlsx / .xlsm).

- **Column A** is the key, **column B** is one tag set. Column C onward is ignored (use it for notes).
- `<Sheet/Key>` picks one random column-B cell out of every row on `Sheet` whose column A equals `Key`.
  Add an option by adding another row with the same key.
- `<*Sheet/Key>` walks the rows in order, like `<*fragment>`.
- Sheet and key names ignore case and extra / full-width spaces.
- A cell may contain other references such as `<wedding_dress_types>` or `<Other/Key>`.
- A row whose column A or B starts with `#` is ignored. A line break inside a cell becomes `, `.
- The file is re-read at every generation when its modification time or size changed, so edit and save in
  Excel and the next image uses the new content. Excel writes to disk only on save. If a re-read fails (for
  example mid-save) the last good copy is used.
- Fragments saved inside the app win over a sheet reference of the same path.
- While a workbook is configured, a `<Sheet/Key>` that resolves to nothing (typo in the sheet or key, empty
  key, unreadable workbook) fails that image with a message instead of sending the literal text to NovelAI.

## Shared variables (`$Name`, `${Name: ...}`)

Define once, in any prompt field:

```
$Location = random(WEDDING, PARTY, PERFORMANCE)
$Location = random(<Events/Venues>)          # pool from a sheet (or a saved fragment)
```

The value is rolled once per image and is identical in every field. Definition lines are removed before the
prompt is sent. Use it with:

```
${Location}                                                       the rolled value
${Location: WEDDING => church, altar | PARTY => balloons | * => plain room}
${Location: WEDDING, PARTY => festive}                             several labels = any of them
```

- Branches are separated by `|`, label and text by `=>`, `*` is the default. With no match and no `*` the
  block produces nothing (and stray commas are cleaned up).
- Branch text can contain fragments, `<Sheet/Key>`, inline `<a|b>` wildcards, emphasis brackets and nested
  `${...}` blocks.
- Names and labels ignore case. An undefined variable or a malformed block fails that image with a message.
- Token counts use each variable's first option and never fail.

## Processing order

1. Comment lines (`#`) are removed.
2. `$Name = ...` lines are collected from all fields and rolled once.
3. `${...}` blocks are resolved in every field.
4. `<fragments>`, `<Sheet/Key>` and the existing wildcard syntaxes are expanded.
