<script setup lang="ts">
import { provideMenuGroup, useMenuContext } from "@/lib/use-menu"
import { menuSlot } from "./styles"

defineOptions({ inheritAttrs: false })
const ctx = useMenuContext()
const labelId = provideMenuGroup()
</script>

<template>
  <li role="none" class="contents">
    <div role="group" class="contents" :aria-labelledby="labelId" :data-slot="menuSlot(ctx.kind, 'group')" v-bind="$attrs">
      <slot />
    </div>
  </li>
</template>
