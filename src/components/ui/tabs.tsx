import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { revealFocusIn, revealInline } from "@/lib/revealInline"
import { wheelToInline } from "@/lib/wheelToInline"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

// A LIST WIDER THAN ITS ROW SCROLLS, it never spills. `max-w-full` keeps it in
// its container; the triggers keep their natural width and the list scrolls
// horizontally. `justify-start`, not `justify-center`: the triggers grow
// (`flex-1`) or the list fits its content (`w-fit`), so there is never free space
// to center — except when they overflow, where centering pushed the first
// triggers past the start edge, out of reach of any scroll. The default variant
// clips vertically too (the triggers' hidden `after` underline sits 5 px below
// them and would otherwise add a vertical scrollbar); the line variant shows that
// underline, so it keeps its overflow visible.
// The scrolling variant HIDES ITS SCROLLBAR (lot 10): where scrollbars always show
// (Windows, or macOS set so) the bar took its height inside the list's 32 px and
// squashed the triggers. The hidden triggers stay in reach: a trackpad's swipe,
// Shift+wheel, the arrow keys (the active trigger is brought into view), and a
// plain mouse wheel (below, `wheelToInline`).
const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit max-w-full items-center justify-start rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default:
          "bg-muted overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ref,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const setRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      listRef.current = el
      if (typeof ref === "function") ref(el)
      else if (ref) ref.current = el
    },
    [ref]
  )
  // The ACTIVE tab is brought into view when it changes (and on mount): on a
  // narrow screen it can sit past the edge of a scrolled list. Only when it
  // changes — a re-render must not undo a reader's own scroll — or when the
  // list itself changes width (sidebar opened, phone turned): a reader's own
  // scroll changes no width.
  const shownActive = React.useRef<Element | null>(null)
  React.useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const active = list.querySelector('[data-slot="tabs-trigger"][data-state="active"]')
    if (active === shownActive.current) return
    shownActive.current = active
    revealInline(list, active)
  })
  React.useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const ro = new ResizeObserver(() =>
      revealInline(list, list.querySelector('[data-slot="tabs-trigger"][data-state="active"]'))
    )
    ro.observe(list)
    return () => ro.disconnect()
  }, [])
  // The FOCUSED trigger too (lot 26): the arrow keys move the focus along the list
  // ahead of its value (a list kept in the URL follows it a route later), and a
  // trigger they landed on past the edge was read unseen.
  React.useEffect(() => {
    const list = listRef.current
    if (!list) return
    const onFocusIn = (e: FocusEvent) => revealFocusIn(list, e.target, '[data-slot="tabs-trigger"]')
    list.addEventListener("focusin", onFocusIn)
    return () => list.removeEventListener("focusin", onFocusIn)
  }, [])
  // A plain mouse wheel scrolls an overflowing list sideways, and gives the page
  // its scroll back at either end (`wheelToInline`). A listener of its own, not
  // `onWheel`: React's wheel listeners are passive and could not keep the page
  // from scrolling under the list.
  React.useEffect(() => {
    const list = listRef.current
    if (!list || variant !== "default") return
    const onWheel = (e: WheelEvent) => {
      if (list.getAttribute("aria-orientation") === "vertical") return
      const next = wheelToInline({
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey,
        scrollLeft: list.scrollLeft,
        scrollWidth: list.scrollWidth,
        clientWidth: list.clientWidth,
      })
      if (next === null) return
      e.preventDefault()
      list.scrollLeft = next
    }
    list.addEventListener("wheel", onWheel, { passive: false })
    return () => list.removeEventListener("wheel", onWheel)
  }, [variant])
  return (
    <TabsPrimitive.List
      ref={setRef}
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
