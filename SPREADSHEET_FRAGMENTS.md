# Spreadsheet fragments, rows, weights and shared variables

Prompt features that work together. All of them are applied per generated image, in every prompt field
(main prompt, main negative, each character prompt, each character negative).

## Spreadsheet fragments (`<Sheet/Key>`)

Settings → Storage → **Spreadsheet fragments (.xlsx)** selects one workbook (.xlsx / .xlsm).

- **Column A** is the key, **column B** is one tag set.
- `<Sheet/Key>` picks one random column-B cell out of every row on `Sheet` whose column A equals `Key`.
  Add an option by adding another row with the same key.
- `<*Sheet/Key>` walks the rows in order, like `<*fragment>`.
- Sheet and key names ignore case and extra / full-width spaces.
- A cell may contain other references such as `<colours>` or `<Other/Key>`.
- **A cell keeps its line breaks** (Alt+Enter in Excel), so one cell can hold several prompt lines, including
  `$Name = ...` definition lines and `${...}` blocks.
- A row whose column A or B starts with `#` is ignored. Inside a cell, a line starting with `#` is a comment
  and is dropped; trailing spaces on each line are trimmed.
- The file is re-read at every generation when its modification time or size changed, so edit and save in
  Excel and the next image uses the new content. Excel writes to disk only on save. If a re-read fails (for
  example mid-save) the last good copy is used. Formula cells are read as the result Excel last saved.
- Fragments saved inside the app win over a sheet reference of the same path.
- While a workbook is configured, a `<Sheet/Key>` that resolves to nothing (typo in the sheet or key, empty
  key, unreadable workbook) fails that image with a message instead of sending the literal text to NovelAI.

### The header row

**Row 1 of every sheet is its header row.** Header names are used two ways:

- **A column headed `weight`** gives each row a relative chance. Blank = 1, `0` = never picked, `3` = three
  times as likely as a row with 1. Decimals work. Sheets without a `weight` column pick every row equally.
- **`row(...)`** (below) reads every column of a row by its header name.

A header name becomes a field name by lower-casing it and turning every run of spaces and punctuation into `_`:
`Lighting` → `lighting`, `Clothing Category` → `clothing_category`, `total (auto)` → `total_auto`.

Columns that nothing refers to are ignored, so they stay free for notes.

### One specific row: `#N`

`<Sheet/Key#12>` narrows a lookup to row 12 of the sheet (the row number Excel shows), which must have that key.
`<fragment#3>` is line 3 of a saved fragment. The roll preview and the image metadata use this to point at the
exact row that was picked.

## Weights

```
<calm @3|tense|cheerful @0.5>                  inline random: " @n" after an option sets its weight
$Mood = random(calm @3, tense, cheerful @0.5)  same inside random()
$Place = random(<Places/outdoor> @2, home)      a weighted reference multiplies each of its rows' weights
```

The weight goes at the end of the option, after a space. Options without one weigh 1; `@0` turns an option off.

## Fallbacks: `??`

```
<Clothes/formal_${tier} ?? Clothes/default_${tier}>
<Extras/${Place.category} ?? >
```

The first reference that has rows wins; a missing sheet or key only fails the image when it is the last
alternative. An empty last alternative means "nothing" (and the stray comma is cleaned up).

## Shared variables (`$Name`, `${Name: ...}`)

Define once, on a line of its own:

```
$Location = random(MARKET, PARK, STATION)
$Location = random(<Events/Venues>)
```

(`random(<Events/Venues>)` takes its pool from every row of that key. Put no comment after a definition on the
same line: a `#` comment must be a whole line.)

The value is rolled once per image and is identical everywhere. Definition lines are removed before the prompt
is sent. A definition can be written in any prompt field, **or inside a fragment or a spreadsheet cell**: only
the fragment line or cell that was actually picked counts. For example, a cell

```
indoors, concert hall, stage, spotlight
$dress_code = formal
```

used as `<Scenes/concert hall>` in the main prompt sets `dress_code` for every character prompt too. Use a
variable with:

```
${Location}                                                         the rolled value
${Location: MARKET => stalls, awning | PARK => trees | * => plain room}
${Location: MARKET, STATION => crowd}                                several labels = any of them
```

- Branches are separated by `|`, label and text by `=>`, `*` is the default. With no match and no `*` the
  block produces nothing (and stray commas are cleaned up).
- Branch text can contain fragments, `<Sheet/Key>`, inline `<a|b>` wildcards, emphasis brackets and nested
  `${...}` blocks.
- A `${...}` block can itself sit inside a saved fragment (one line) or a spreadsheet cell.
- Names and labels ignore case. An undefined variable or a malformed block fails that image with a message.
- A variable defined twice (for example once in the prompt and once in a picked cell) fails that image with a
  message (unless one of them is fixed with `:=`, see below).

### Variables inside references

A reference may contain `${...}`. It is looked up after the variables are rolled, so the key can depend on them:

```
$tier = random(regular @3, special)
<Clothes/${dress_code}_${tier}>
<Poses/${act}_${pose: p1 => one | p2 => two | * => any}>
```

The row such a reference picks may contain fragments, wildcards and `${...}` blocks, but **not** `$Name = ...`
definitions: it is only reached after every variable was rolled, so a definition there fails the image.

### Definitions that use other variables

Definitions are rolled in the order they are met: field by field (main prompt, main negative, then each
character prompt and negative), each field's own lines before the fragment lines and cells it picks. Fixed
`:=` definitions are rolled before all others. A definition may use `${...}` of any variable rolled before it:

```
$category = random(<Places/categories>)
$place = random(<Places/${category}>)
```

### Whole rows: `row(...)`

```
$Place = row(<Places/outdoor>)
$Place = row(<*Places/outdoor>)                walk the rows in order
$Place = row(<Places/${category} ?? Places/default>)
```

`row()` picks one row (by its weight) and keeps all of its columns:

- `${Place}` is the row's column B (which may be empty);
- `${Place.lighting}`, `${Place.clothing_category}` ... are the other columns, by header name, and work in
  branches like any variable: `${Place.weather: rain => umbrella | * => }`.

So a sheet can hold one row per scene with one column per prompt part, instead of building a single long
column-B string with formulas. Empty columns resolve to nothing. Text in a column is expanded like prompt text
(fragments, wildcards, `${...}`), but must not contain `$Name = ...` definitions.

**Index sheets:** when the picked cell is nothing but another sheet reference (`<Places/outdoor>`), `row()`
follows it and picks a row there, so a sheet of references can choose between categories:

```
Index:      key   | target
            any   | <Places/outdoor>
            any   | <Places/indoor>

$Place = row(<Index/any>)          -> a row from Places/outdoor or Places/indoor
$Panel = row(<*Index/pages>)       -> walks the index in order, and reads each target row
```

An unknown column fails the image with the list of the row's columns.

### Fixed values: `:=`

```
$Mood := calm
$Place := row(<Places/outdoor#3>)
```

A fixed definition wins over every ordinary `=` definition of the same name, wherever that is (prompt, fragment
or cell), so you can pin some variables without editing the workbook. Fixing the same name twice fails.

## Roll preview and image metadata

- The **dice button** next to the prompt header rolls the current prompts once without generating: it shows the
  final main / negative / character texts, every variable's value and every fragment line and sheet row that
  was picked (with its row number), or the error that generation would fail with. `<*...>` walks are not
  advanced by a preview.
- Every generated image stores the rolled variables in its metadata (PNG). The metadata dialog lists them.
- **Copy as fixed values** (in both places) copies one `$name := ...` line per variable. Paste the lines into the
  main prompt to reproduce those exact values (rows are referenced as `<Sheet/Key#row>`) while everything else
  rolls again; delete the lines you want to roll freely.
- Token counts use each variable's first option and never fail.

## Processing order

1. Comment lines (`#`) are removed.
2. `${...}` blocks, and references that contain one, are set aside. `$Name = ...` lines are collected from every
   prompt field, and from every fragment line / cell that gets picked while `<fragments>`, `<Sheet/Key>` and the
   existing wildcard syntaxes are expanded.
3. Every collected definition is rolled once, in order (fixed `:=` definitions first).
4. The set-aside blocks and references are resolved, in any field, in any order. The chosen text is expanded
   like normal prompt text.
