<script lang="ts">
import type { PropType, VNode } from "vue"
import { cloneVNode, Comment, defineComponent, Fragment, h, mergeProps } from "vue"

export interface PrimitiveProps {
  /** Render the first slot vnode instead of a wrapper, merging attrs into it. */
  asChild?: boolean
  /** Tag or component to render. */
  as?: string | object
}

const SELF_CLOSING_TAGS = ["area", "img", "input"]

function flatten(nodes: VNode[]): VNode[] {
  return nodes.flatMap(node =>
    node.type === Fragment ? flatten((node.children ?? []) as VNode[]) : [node],
  )
}

export default defineComponent({
  name: "Primitive",
  inheritAttrs: false,
  props: {
    asChild: { type: Boolean, default: false },
    as: { type: [String, Object] as PropType<string | object>, default: "div" },
  },
  setup(props, { attrs, slots }) {
    return () => {
      if (!props.asChild) {
        if (typeof props.as === "string" && SELF_CLOSING_TAGS.includes(props.as))
          return h(props.as, attrs)
        return h(props.as as string, attrs, { default: slots.default })
      }
      if (!slots.default)
        return null
      const children = flatten(slots.default())
      const index = children.findIndex(child => child.type !== Comment)
      if (index === -1)
        return children
      const first = children[index]
      // The slot owner's ref wins: attrs are merged, the child's own ref is dropped
      if (first.props)
        delete first.props.ref
      const merged = first.props ? mergeProps(attrs, first.props) : attrs
      const cloned = cloneVNode({ ...first, props: {} }, merged)
      if (children.length === 1)
        return cloned
      children[index] = cloned
      return children
    }
  },
})
</script>
