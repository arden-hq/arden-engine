import { defineComponent, markReactive, type StateField } from "@openuidev/lang-core"
import { z } from "zod"
import { Format } from "./format.js"
import { FormulaVars, PlotSpec } from "./plot.js"
import { ChartSpec, DiagramSpec } from "./specs.js"

/** The glyphs a card or tile may name; the renderer maps each to an icon. */
const ICON_NAMES = [
  "money",
  "train",
  "weather",
  "car",
  "wallet",
  "place",
  "calendar",
  "food",
  "hotel",
  "shield",
  "clock",
  "flight",
  "card",
  "star",
  "document"
] as const
export type IconName = (typeof ICON_NAMES)[number]
const IconName = z.enum(ICON_NAMES)

function reactive<T extends z.ZodType>(schema: T): z.ZodType<StateField<z.infer<T>>> {
  markReactive(schema)
  return schema as unknown as z.ZodType<StateField<z.infer<T>>>
}

function part<T extends z.ZodObject>(config: { name: string; description: string; props: T }) {
  return defineComponent({ ...config, component: null })
}

const Stack = part({
  name: "Stack",
  description: "Vertical (default) or horizontal group of blocks. The root of every answer block.",
  props: z.object({
    children: z.array(z.any()),
    direction: z.enum(["column", "row"]).optional(),
    gap: z.enum(["s", "m", "l"]).optional()
  })
})

const Option = part({
  name: "Option",
  description: "One choice of a Segmented control.",
  props: z.object({ value: z.string(), label: z.string() })
})

const Segmented = part({
  name: "Segmented",
  description: "Pick one of 2–4 short options. Bind value to a $variable.",
  props: z.object({
    name: z.string(),
    options: z.array(Option.ref),
    value: reactive(z.string().optional()),
    label: z.string().optional()
  })
})

const Slider = part({
  name: "Slider",
  description:
    "A number on a range. Bind value to a $variable; unit is a plural word (hours, runs, dollars) or percent.",
  props: z.object({
    label: z.string(),
    min: z.number(),
    max: z.number(),
    step: z.number().optional(),
    value: reactive(z.number().optional()),
    unit: z.string().optional(),
    stops: z.array(z.string()).optional()
  })
})

const Switch = part({
  name: "Switch",
  description: "An on/off choice with a label and an optional hint. Bind value to a $variable.",
  props: z.object({
    label: z.string(),
    hint: z.string().optional(),
    value: reactive(z.boolean().optional())
  })
})

const Metric = part({
  name: "Metric",
  description:
    "One labelled figure. Use inside Summary. For a value that needs ^, exp or ln, use Formula.",
  props: z.object({
    label: z.string(),
    value: z.any(),
    format: Format.optional(),
    hint: z.string().optional()
  })
})

const FORMULA_WORDS =
  "numbers, the named vars, + - * / ^ (power), parentheses, min, max, abs, round(v, digits), floor, ceil, exp, ln, log10, sqrt, pow"

const Formula = part({
  name: "Formula",
  description:
    "One labelled figure computed from a formula, like a Metric: label, fn, vars ({name: number or $variable}), format, hint. fn uses the same math as Plot. Use inside Summary, one per figure.",
  props: z.object({
    label: z.string(),
    fn: z.string(),
    vars: FormulaVars.optional(),
    format: Format.optional(),
    hint: z.string().optional()
  })
})

const Summary = part({
  name: "Summary",
  description: "2–4 Metrics or Formulas in a row: the figures the reader takes in at a glance.",
  props: z.object({ metrics: z.array(z.union([Metric.ref, Formula.ref])) })
})

const BarChart = part({
  name: "BarChart",
  description: "Bars for one series; labels and values are parallel arrays.",
  props: z.object({
    labels: z.array(z.string()),
    values: z.array(z.number()),
    format: Format.optional(),
    highlight: z.enum(["min", "max"]).optional()
  })
})

const Col = part({
  name: "Col",
  description: "One table column: a header and its cells. highlight marks the winning column.",
  props: z.object({
    label: z.string(),
    cells: z.array(z.any()),
    format: Format.optional(),
    highlight: z.boolean().optional()
  })
})

const Table = part({
  name: "Table",
  description:
    "A table built from Col columns of equal length. A first Col with an empty label is the row names. The reader sorts it by clicking a header.",
  props: z.object({ columns: z.array(Col.ref) })
})

const Callout = part({
  name: "Callout",
  description: "The verdict in one line, with a short reason. tone: good, info or warn.",
  props: z.object({
    title: z.string(),
    text: z.string().optional(),
    tone: z.enum(["good", "info", "warn"]).optional()
  })
})

const Row = part({
  name: "Row",
  description:
    "A list row: title, detail, an amount, and a switch when value binds a $variable. Leave value out for a plain row.",
  props: z.object({
    title: z.string(),
    detail: z.string().optional(),
    amount: z.number().optional(),
    value: reactive(z.boolean().optional())
  })
})

const List = part({
  name: "List",
  description: "A list of Rows.",
  props: z.object({ rows: z.array(Row.ref) })
})

const Header = part({
  name: "Header",
  description:
    "The block's title and one line under it. First child of root when the block is a whole answer.",
  props: z.object({ title: z.string(), subtitle: z.string().optional() })
})

const VisualCard = part({
  name: "VisualCard",
  description: "An image card: id, title, one line, https image URL, optional tag and tag icon.",
  props: z.object({
    value: z.string(),
    title: z.string(),
    body: z.string().optional(),
    image: z.string().optional(),
    tag: z.string().optional(),
    icon: IconName.optional()
  })
})

const VisualCards = part({
  name: "VisualCards",
  description: "2–4 image cards in a row. Bind value to a $variable to make them a single choice.",
  props: z.object({
    name: z.string(),
    cards: z.array(VisualCard.ref),
    value: reactive(z.string().optional())
  })
})

const OptionCard = part({
  name: "OptionCard",
  description: "A choice card: id, title, one line, optional icon and tag.",
  props: z.object({
    value: z.string(),
    title: z.string(),
    body: z.string().optional(),
    icon: IconName.optional(),
    tag: z.string().optional()
  })
})

const OptionCards = part({
  name: "OptionCards",
  description: "2–4 cards to pick one from. Bind value to a $variable.",
  props: z.object({
    name: z.string(),
    options: z.array(OptionCard.ref),
    value: reactive(z.string().optional())
  })
})

const Tile = part({
  name: "Tile",
  description: "A fact with an icon: icon, label, value, and the value's format.",
  props: z.object({
    icon: IconName.optional(),
    label: z.string(),
    value: z.any(),
    format: Format.optional()
  })
})

const Tiles = part({
  name: "Tiles",
  description: "2–6 Tiles in a grid: the facts a reader checks at a glance.",
  props: z.object({ tiles: z.array(Tile.ref) })
})

const Step = part({
  name: "Step",
  description: "One step: title and one line.",
  props: z.object({ title: z.string(), body: z.string().optional() })
})

const Steps = part({
  name: "Steps",
  description: "Numbered steps in order.",
  props: z.object({ items: z.array(Step.ref) })
})

const TabItem = part({
  name: "TabItem",
  description: "One tab: id, label, its blocks.",
  props: z.object({ value: z.string(), label: z.string(), children: z.array(z.any()) })
})

const Tabs = part({
  name: "Tabs",
  description:
    "Tabs; one shows at a time. Bind value to a $variable (it may be the same one a card choice uses).",
  props: z.object({
    name: z.string(),
    items: z.array(TabItem.ref),
    value: reactive(z.string().optional())
  })
})

const Photo = part({
  name: "Photo",
  description: "One photo: https URL from a tool result, and a caption.",
  props: z.object({ src: z.string(), caption: z.string().optional() })
})

const Gallery = part({
  name: "Gallery",
  description: "1–4 photos in a row; click one to enlarge.",
  props: z.object({ photos: z.array(Photo.ref) })
})

const Stepper = part({
  name: "Stepper",
  description: "A small whole number with − and + (people, nights). Bind value to a $variable.",
  props: z.object({
    label: z.string(),
    min: z.number(),
    max: z.number(),
    value: reactive(z.number().optional())
  })
})

const CheckItem = part({
  name: "CheckItem",
  description: "One checklist line: id, optional time, title, one line.",
  props: z.object({
    value: z.string(),
    time: z.string().optional(),
    title: z.string(),
    body: z.string().optional()
  })
})

const Checklist = part({
  name: "Checklist",
  description:
    "Steps the reader ticks off, with a done counter. Bind value to a $variable that starts as [].",
  props: z.object({
    name: z.string(),
    items: z.array(CheckItem.ref),
    value: reactive(z.array(z.string()).optional()),
    title: z.string().optional()
  })
})

const Copy = part({
  name: "Copy",
  description: "Copies text built from the block's current values.",
  props: z.object({ label: z.string(), text: z.string() })
})

const Series = part({
  name: "Series",
  description: "One line of a LineChart: name and values.",
  props: z.object({ name: z.string(), values: z.array(z.number()) })
})

const LineChart = part({
  name: "LineChart",
  description:
    "1–3 lines over the same labels; optional fixed y range so lines move instead of rescaling.",
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    min: z.number().optional(),
    max: z.number().optional()
  })
})

const Plot = part({
  name: "Plot",
  description: `A line chart of formulas over x, computed in place as its $variables change: {x: {from, to, step?, label?}, series: [{name, fn, vars}] (1–4), format?, min?, max?, height?}. fn uses x, ${FORMULA_WORDS}; vars maps each other name to a number or a $variable.`,
  props: z.object({ spec: PlotSpec })
})

const Chart = part({
  name: "Chart",
  description:
    "A chart drawn from its spec: labels with series, or data rows named by x, y and group. Any field may use $variables; the chart redraws in place.",
  props: z.object({ spec: ChartSpec })
})

const Diagram = part({
  name: "Diagram",
  description:
    "A diagram from nodes and edges, at most 40 nodes; direction down fits the chat best.",
  props: z.object({ spec: DiagramSpec })
})

const App = part({
  name: "App",
  description:
    'Custom HTML, CSS and JS in a sandbox with no network, for what no other part draws. Write html inline as one string with \\n for new lines (150 KB at most); it never changes after the answer. It fits its content; height in px is only the room held while it loads; libraries ["d3"] to use d3.',
  props: z.object({
    title: z.string(),
    html: z.string(),
    height: z.number().optional(),
    libraries: z.array(z.enum(["d3"])).optional()
  })
})

const Rows = part({
  name: "Rows",
  description:
    "Live rows for app objects, from arden: links (arden:task/<id>, arden:session/<id>, …); every field is read live. 50 at most.",
  props: z.object({ refs: z.array(z.string()) })
})

const Image = part({
  name: "Image",
  description: "One image: an https address that came from a tool result, and a caption.",
  props: z.object({ src: z.string(), caption: z.string().optional() })
})

const Button = part({
  name: "Button",
  description:
    "Sends a message to the chat as you (Action with @ToAssistant). It never runs anything by itself.",
  props: z.object({
    label: z.string(),
    action: z.any(),
    variant: z.enum(["primary", "secondary"]).optional(),
    disabled: z.boolean().optional()
  })
})

/** Every part an `arden:ui` block may use, by name. The order is the order the
 *  prompt lists them in. */
export const ANSWER_PARTS = {
  Stack,
  Header,
  Option,
  Segmented,
  Slider,
  Switch,
  Metric,
  Formula,
  Summary,
  BarChart,
  Col,
  Table,
  Callout,
  Row,
  List,
  VisualCard,
  VisualCards,
  OptionCard,
  OptionCards,
  Tile,
  Tiles,
  Step,
  Steps,
  TabItem,
  Tabs,
  Photo,
  Gallery,
  Stepper,
  CheckItem,
  Checklist,
  Copy,
  Series,
  LineChart,
  Plot,
  Chart,
  Diagram,
  App,
  Rows,
  Image,
  Button
} as const

export type ComponentName = keyof typeof ANSWER_PARTS

/** The part names, in the parts' order. */
export const COMPONENT_NAMES = Object.keys(ANSWER_PARTS) as readonly ComponentName[]

/** The props a part's renderer receives, as the schema reads them. */
export type PartProps<K extends ComponentName> = z.infer<(typeof ANSWER_PARTS)[K]["props"]>
