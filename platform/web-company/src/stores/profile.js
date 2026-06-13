import { defineStore } from 'pinia'
import { getProfile } from '../api/company'

export const useProfileStore = defineStore('profile', {
  state: () => ({
    profile: null,
    loading: false
  }),
  actions: {
    async fetch() {
      this.loading = true
      try {
        this.profile = await getProfile()
        return this.profile
      } finally {
        this.loading = false
      }
    }
  }
})
