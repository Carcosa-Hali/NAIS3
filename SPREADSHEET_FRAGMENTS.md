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
- **A cell keeps its line breaks** (Alt+Enter in Excel), so one cell can hold several prompt lines, including
  `$Name = ...` definition lines and `${...}` blocks.
- A row whose column A or B starts with `#` is ignored. Inside a cell, a line starting with `#` is a comment
  and is dropped; trailing spaces on each line are trimmed.
- The file is re-read at every generation when its modification time or size changed, so edit and save in
  Excel and the next image uses the new content. Excel writes to disk only on save. If a re-read fails (for
  example mid-save) the last good copy is used.
- Fragments saved inside the app win over a sheet reference of the same path.
- While a workbook is configured, a `<Sheet/Key>` that resolves to nothing (typo in the sheet or key, empty
  key, unreadable workbook) fails that image with a message instead of sending the literal text to NovelAI.

## Shared variables (`$Name`, `${Name: ...}`)

Define once, on a line of its own:

```
$Location = random(WEDDING, PARTY, PERFORMANCE)
$Location = random(<Events/Venues>)
```

(`random(<Events/Venues>)` takes its pool from every row of that key. Put no comment after a definition on the
same line: a `#` comment must be a whole line.)

The value is rolled once per image and is identical everywhere. Definition lines are removed before the prompt
is sent. A definition can be written in any prompt field, **or inside a fragment or a spreadsheet cell**: only
the fragment line or cell that was actually picked counts. For example, a cell

```
indoors, strip club, runway stage, spotlight
$outfits = lingerie
```

used as `<Scenes/strip club>` in the main prompt sets `outfits` for every character prompt too. Use a variable with:

```
${Location}                                                       the rolled value
${Location: WEDDING => church, altar | PARTY => balloons | * => plain room}
${Location: WEDDING, PARTY => festive}                             several labels = any of them
```

- Branches are separated by `|`, label and text by `=>`, `*` is the default. With no match and no `*` the
  block produces nothing (and stray commas are cleaned up).
- Branch text can contain fragments, `<Sheet/Key>`, inline `<a|b>` wildcards, emphasis brackets and nested
  `${...}` blocks.
- A `${...}` block can itself sit inside a saved fragment (one line) or a spreadsheet cell.
- Names and labels ignore case. An undefined variable or a malformed block fails that image with a message.
- A variable defined twice (for example once in the prompt and once in a picked cell) fails that image with a
  message. A definition that only appears inside a chosen `${...}` branch is too late to be used and fails too.
- Token counts use each variable's first option and never fail.

## Processing order

1. Comment lines (`#`) are removed.
2. `${...}` blocks are set aside. `$Name = ...` lines are collected from every prompt field, and from every
   fragment line / cell that gets picked while `<fragments>`, `<Sheet/Key>` and the existing wildcard syntaxes are
   expanded.
3. Every collected definition is rolled once.
4. The set-aside blocks are resolved, in any field, in any order. The chosen branch is expanded like normal prompt
   text.
