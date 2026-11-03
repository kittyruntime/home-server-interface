<script setup lang="ts">
import { useMenuContext } from "@/lib/use-menu"
import { menuSlot } from "./styles"

defineOptions({ inheritAttrs: false })
const ctx = useMenuContext()
</script>

<template>
  <li role="none" class="contents">
    <div role="group" class="contents" :data-slot="menuSlot(ctx.kind, 'group')" v-bind="$attrs">
      <slot />
    </div>
  </li>
</template>
