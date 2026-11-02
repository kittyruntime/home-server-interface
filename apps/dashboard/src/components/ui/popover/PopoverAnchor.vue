<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, ref } from "vue"
import type { PrimitiveProps } from "../Primitive.vue"
import Primitive from "../Primitive.vue"
import { popoverKey } from "./context"

const props = defineProps<PrimitiveProps>()
const ctx = inject(popoverKey)!

const el = ref<InstanceType<typeof Primitive> | null>(null)
onMounted(() => ctx.setAnchor((el.value?.$el as HTMLElement | undefined) ?? null))
onBeforeUnmount(() => ctx.setAnchor(null))
</script>

<template>
  <Primitive ref="el" data-slot="popover-anchor" :as="props.as" :as-child="props.asChild">
    <slot />
  </Primitive>
</template>
