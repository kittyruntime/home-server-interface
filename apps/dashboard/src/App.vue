<template>
  <RouterView v-slot="{ Component }">
    <Transition name="ui-fade" mode="out-in">
      <!-- .route-fade scopes the fast duration to the fade itself; an inline
           --ui-dur here would inherit into every descendant transition. -->
      <component :is="Component" class="route-fade" />
    </Transition>
  </RouterView>
</template>
