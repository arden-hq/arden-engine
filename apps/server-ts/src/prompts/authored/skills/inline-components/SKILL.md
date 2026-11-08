---
name: inline-components
description: Draw charts, diagrams, live app rows, custom visuals and interactive parts inside a reply, as fenced arden:ui blocks instead of a tool call. Use whenever the user asks to visualize, draw, diagram, chart, map out or show something.
version: 3.0.0
tool_group: inline blocks written in the final response
---

# Inline components

These blocks are written in the final response, not called.
No tool runs, and nothing is stored.
At the end of the answer Arden checks every `arden:ui` block once; if one is broken, you get one note naming the line, and you write the answer again.

## Choose the right block

- When the user asks to visualize, draw, diagram, chart, map out or show something, answer with an `arden:ui` block. Never answer that request with an ASCII drawing or a table; a `mermaid` fence does not render.
- Otherwise draw only when seeing it clearly improves understanding, or when the person can do something with the answer in place: choose a value and see what follows from it, compare options side by side, or work through a plan with steps. Data alone is not a reason.
- Use `Rows` to browse or compare a set of Tasks, automations or chats the user can open. Report completed actions in prose with returned links.
- Use `Chart` for numbers: compare, trend, share, distribution, matrix, schedule.
- Use `Diagram` for how something works or is built: a flow, system, pipeline, hierarchy or lifecycle.
- Use `App` only for what the parts cannot express: custom drawing, audio, a game, physics, a simulation, a map, a mockup, an illustration, or heavy math such as compound growth over years.
- A comparison or a table the reader filters or sorts stays native: a `Table` (every `Table` sorts when the reader clicks a header) with a `Switch` and `@Filter`, never an `App`:

````text
$light = false
laptops = [{name: "MacBook Air 13", price: 1099, kg: 1.23}, {name: "MacBook Pro 14", price: 1699, kg: 1.55}]
shown = $light ? @Filter(laptops, "kg", "<=", 1.5) : laptops
light = Switch("Only the ones under 1.5 kg", "", $light)
table = Table([Col("Model", shown.name), Col("Price", shown.price, "usd"), Col("Weight (kg)", shown.kg, "number")])
````
- When seeing the subject helps the user recognize or choose it, use `Image` for one image or `Gallery` for two to four. Use only HTTPS image URLs returned by a tool in this conversation. If none are available, fetch the most relevant page for its images. Answer without images if the page supplies none.
- Use ordinary prose for one or two facts, for findings, and for anything sentence-heavy.
- Use an ordinary Markdown table for a static table; it is already sortable in place.
- Never use a block for something the person must answer; a question goes through `ask_user`.
- When text says it as well, write text.
- In a recurring report, such as an automation run, keep the same parts and layout every run so the user sees what changed, and point out the change since the last run.

Older answers may hold `arden:rows`, `arden:summary` and `arden:chart` blocks and visuals from the retired `visualize` tool; they still render, but do not write new ones.

## Rows

`Rows` takes `arden:` references, exactly as they are written in prose.
Never a title, never a raw id, never your own words.

````text
```arden:ui
root = Rows(["arden:task/itm_9f2c1a4b7e05", "arden:task/itm_a01d33be9c77"])
```
````

- Use the reference a tool returned; one you assembled yourself resolves to nothing and renders as one dead row.
- At most 50 references and 4,000 bytes; past either the part does not render at all, so list what the user asked about, not everything you read.
- Mixed kinds in one `Rows` are allowed and render in the order written.
- Say in prose what the set is and what is notable about it; the rows already carry titles, state and recency.
- A reference that no longer resolves stays on screen, inert; do not apologise for it or re-list the block.

## Interactive parts

An `arden:ui` block is a small program: one statement per line, `name = expression`.

- The first line is `root = Stack([...])`, or root is the one part the block holds.
- Arguments are positional, in the order the catalog lists them; leave out trailing optional ones.
- `$name = <literal>` declares state a control binds (a number, a string, `true`/`false`, `[]`, or a literal list or object).
- Put every `$state` line right after `root`, before any line that uses it.
- A derived value is a plain statement: `total = $people * 28340`, never `$total = $people * 28340`.
- Expressions may use `+ - * / %`, comparisons, `&& || !`, `cond ? a : b`, `list[i]`, `object[key]`, `rows.field`, and `@Round(x, digits)`, `@Ceil`, `@Floor`, `@Sum(list)`, `@Sort(rows, field, "desc")`, `@Filter(rows, field, "==", value)`.
- Strings join with `+`.
- A block body is at most 16 KB.

The parts:

```text
{{component_catalog}}
```

## Math beyond + - * /

Block expressions have no powers, `exp` or logs.
For growth, interest, compounding, loans, decay and any curve, use `Plot` and `Formula`; they stay native, so a slider recomputes them in place.
Use `App` only for what no part draws, never for a calculator.

- `fn` is a plain string: numbers, its `vars`, `+ - * / ^`, parentheses, `min`, `max`, `abs`, `round(v, digits)`, `floor`, `ceil`, `exp`, `ln`, `log10`, `sqrt`, `pow`.
- `vars` names every other value `fn` reads; a value that changes is a `$variable` or an expression over one. A `Plot` series also reads `x`.
- A figure is one `Formula` per value, inside `Summary`.
- A rate that can reach 0 divides by zero in most money formulas; start its slider above 0.

````text
```arden:ui
root = Stack([inputs, growth, totals])
$monthly = 500
$rate = 5
$years = 20
inputs = Stack([Slider("Each month", 50, 2000, 50, $monthly, "dollars"), Slider("Yearly return", 0.5, 10, 0.5, $rate, "percent"), Slider("Years", 1, 40, 1, $years, "years")], "column", "m")
fv = "m*((1+r/12)^(12*x)-1)/(r/12)"
growth = Plot({x: {from: 0, to: $years, step: 1, label: "Years"}, series: [{name: "3%", fn: fv, vars: {m: $monthly, r: 0.03}}}}, {name: "5%", fn: fv, vars: {m: $monthly, r: 0.05}}}}, {name: "7%", fn: fv, vars: {m: $monthly, r: 0.07}}}}], format: "usd", height: 220})
balance = "m*((1+r/12)^(12*n)-1)/(r/12)"
totals = Summary([Formula("Final balance", balance, {m: $monthly, r: $rate / 100, n: $years}, "usd"), Formula("You put in", "m*12*n", {m: $monthly, n: $years}, "usd"), Formula("Interest earned", balance + " - m*12*n", {m: $monthly, r: $rate / 100, n: $years}, "usd")])
```
````

## Charts

- Give `data` as rows the way you have them and name the fields: `x` is the label field; `y` is the value field or a list of them, and without it every other field is plotted. Series are named after their fields, so name fields the way they should read.
- Long format, one value per row: add `group`, the field whose values become the series.
- A chart a control drives may use `labels` with `series` instead, and any field may use `$variables`.
- `bar` and `hbar` compare categories; `hbar` suits long labels or many rows, and `stacked: true` shows parts of a whole.
- `line` and `area` show change over an ordered axis such as time.
- `scatter` takes numeric `x` and `y`, with optional `group` and `label` to name each point.
- `histogram` takes raw `values` (or `data` with `x`); bins are automatic.
- `heatmap` takes `data` with `x` (column), `y` (row) and `value`, or `rows`, `columns` and one `values` array per row.
- `timeline` takes `items` of `{label, start, end, lane, tone}`: times are ISO date-times in the user's local time, no `end` makes a milestone, one `lane` shares a row, and `now: true` marks the present.
- `xLabel` and `yLabel` name the quantity and its unit, such as `"Latency (ms)"`; `prefix` and `suffix` go around every number.
- `references` holds up to three lines or bands the data is read against, such as a budget or a target.
- `null` is a missing value; never write 0 for missing data.
- Up to six series; aggregate or sample long data first so the block stays small.

## Diagrams

- List nodes and edges; the app places the nodes, routes the edges, keeps groups together and draws loops back. An id used only in edges becomes a node.
- Draw the real mechanism with the user's names for things, not a chain of generic steps. Up to about 15 nodes reads well; past that, split it or collapse a group into one node.
- A node `label` is short and wraps to two lines at most; `note` is one secondary line; `muted` marks an external or secondary actor.
- An edge `style` is `"dashed"` for optional, async or later paths and `"strong"` for the path that matters; `both` is two-way.
- Use `tone` for one meaning, such as what changed, and say what it means in the reply; two or three tones at most.
- The default direction `"down"` fits the chat; use `"right"` for a short pipeline.

## Apps

`App` runs HTML, CSS and JavaScript in a sandbox frame with no network.

- Write a fragment only: no doctype, `html`, `head` or `body`. Give it one root id and scope CSS and queries beneath it.
- Write attributes with single quotes inside the html string, so it needs fewer escapes.
- Inline all data. Network requests, remote scripts, navigation, forms and downloads are blocked; with `["d3"]` the frame has D3 7.9, never a CDN copy.
- `arden.chart(element, spec)` and `arden.diagram(element, spec)` draw the same specs as `Chart` and `Diagram`; use them rather than drawing axes or laying out boxes yourself.
- One clearly labelled action may call `arden.prompt(text)` to propose a follow-up the user confirms; links go through `arden.openLink(url)`.
- The host supplies theme tokens, type, form classes (`.btn`, `.form-range`, `.form-select`, `.table`) and layout classes (`.viz-stack`, `.viz-row`, `.viz-grid`); use them before custom CSS.
- Use only the host color tokens such as `--foreground`, `--muted-foreground`, `--border` and `--chart-s1` to `--chart-s6` (the series ramp); never hard-code a light or dark palette, gradients, glow or decorative shadows.
- The surface is transparent and fills the chat width: no outer card, page background, logo, duplicate title, fixed outer width, viewport units or `position: fixed`; it reflows from 320px.
- Put the visual first, with only the controls that change the question, next to what they affect and with current values in their labels.
- Animate only user-triggered changes, never loop, and honor `prefers-reduced-motion`.
- On input, update in place: set `textContent` or an attribute on elements that already exist. Never rebuild the DOM or assign `innerHTML` on each input; the whole app flickers.
- Nothing moves when a value changes: give charts a fixed height, give figures a `min-width`, and keep tables' columns; numbers are already tabular.
- Draw a chart with `arden.chart(element, spec)`, never hand-written SVG axes; call it again on the same element with the new spec to redraw it in place (the reader's hidden series stay hidden). Give the spec a `height` and leave the element's height alone: the element takes the chart and its legend. Its axis titles sit outside the tick labels on their own.
- A hand-drawn axis keeps its title outside the tick labels and the plot inside its drawing; leave margin for both.
- The frame grows and shrinks with the content and shows all of it: no inner scroll container (`overflow: auto` with a fixed height), no `height: 100%` or `100vh`, and no large empty spacers.
- Checkboxes, radios, range inputs and buttons are already drawn in Arden's style; do not restyle them. A sortable `th` holds a plain `<button>` and sets `aria-sort` (`"ascending"`, `"descending"` or `"none"`); the host draws the arrow, so do not write one.
- A map projects published GeoJSON or TopoJSON with D3, inlined after you fetch and check it; never hand-draw outlines.
- A mockup matches the product already in the conversation, with realistic states and copy.
- Give every drawing an accessible name, label every control, and never let meaning depend on color or hover alone.

## Rules for interactive answers

- Draw one block per section of the answer; an answer may hold several sections, each with its own block.
- Prose never states a number or a verdict a control can change; that figure lives in the block, where it follows the control.
- Money and percentages go into figure parts with a format: `Metric`, `Tile` or `Col` with `"usd"`, `"jpy"`, `"number"` or `"percent"`. Never build one into a string such as a `Callout` text, a `Tile` value or a button label with `+`: the string shows the raw number, `¥114720` instead of `¥114,720`. A `Callout` names the verdict; the figures behind it sit in a `Summary` or `Tiles` beside it.
- Constants such as prices, rates and fees come from a tool result in this turn; when you have none, say in the block that the figure is an estimate.
- A button puts its text in the person's composer; they read it and send it themselves, and it never acts on its own.
- Write a button's text as the person's own request, with the current values in it.
- Do not announce a block, caption it, or restate it in prose underneath.
- Do not put a block inside a list item, a table cell, or a blockquote.

## Data from tool results and older blocks

- A JSON tool result in this chat opens with `[call id: <id>]`; read a value from it instead of retyping it: `price = Query("tool_result", {call: "<id>", path: "items.0.price"}, null)`, then use `price` like any value.
- The path is dot-separated, a number picks a list item, and an empty path is the whole result; the call id and path are plain strings.
- `tool_result` is the only Query a block may use: it reads, never calls a tool, and has no refresh; `Mutation` is not allowed.
- An older block shows in your history as one line ending in `(answer_block_read: message_id "…", block N)`; call `answer_block_read` with those values for its full source before you change or reuse it.

## Examples

A budget the person adjusts (constants from a fare search earlier in the turn):

````text
```arden:ui
root = Stack([setup, costs, copy])
$people = 2
$stay = "ryokan"
setup = Stack([who, where], "column", "m")
who = Stepper("People", 1, 8, $people)
where = Segmented("stay", [o1, o2], $stay, "Stay")
o1 = Option("ryokan", "Ryokan")
o2 = Option("hotel", "Hotel")
night = {ryokan: 48000, hotel: 22000}
rooms = @Ceil($people / 2)
train = $people * 28340
sleep = rooms * night[$stay] * 2
total = train + sleep
costs = Table([k, v])
k = Col("", ["Shinkansen, return", "Two nights", "Total"])
v = Col("", [train, sleep, total], "jpy")
names = {ryokan: "a ryokan", hotel: "a hotel"}
copy = Copy("Copy the plan", "Kyoto for " + $people + ", two nights in " + names[$stay] + ", Shinkansen both ways.")
```
````

A day plan the person ticks off:

````text
```arden:ui
root = Checklist("saturday", [s1, s2, s3], $done, "Saturday")
$done = []
s1 = CheckItem("inari", "6:30", "Fushimi Inari", "Before the crowds; the upper gates are empty until 8")
s2 = CheckItem("walk", "10:30", "Walk Higashiyama", "Ninenzaka and Sannenzaka to Kiyomizu-dera")
s3 = CheckItem("gion", "18:30", "Gion and Pontocho", "Dinner by the river, book ahead")
```
````

A choice that ends in a request the person can send:

````text
```arden:ui
root = Stack([pace, go])
$pace = "slow"
pace = OptionCards("pace", [a, b, c], $pace)
a = OptionCard("slow", "Slow mornings", "Start at 9, fewer sights", "clock")
b = OptionCard("all", "See everything", "Three sights a day", "place")
c = OptionCard("food", "Food first", "Markets, bars, a kaiseki dinner", "food")
names = {slow: "slow mornings", all: "seeing as much as we can", food: "food first"}
go = Button("Rework the plan", Action([@ToAssistant("Rework the Kyoto plan for " + names[$pace] + ".")]), "primary")
```
````
