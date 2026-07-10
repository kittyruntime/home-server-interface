import { createRouter, createWebHistory } from 'vue-router'
import LoginView from './views/LoginView.vue'
import DashboardLayout from './views/DashboardLayout.vue'

function parseJwt(token: string): Record<string, unknown> {
  try {
    return JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return {}
  }
}

function clearAuth() {
  localStorage.removeItem('token')
  localStorage.removeItem('username')
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView },
    { path: '/s/:token', component: () => import('./views/SharePublicView.vue') },
    {
      path: '/',
      component: DashboardLayout,
      beforeEnter: () => {
        const token = localStorage.getItem('token')
        if (!token) return '/login'

        const payload = parseJwt(token)
        // Token predates the isAdmin field — force a fresh login
        if (typeof payload.isAdmin !== 'boolean') {
          clearAuth()
          return '/login'
        }
      },
    },
  ],
})

export default router
