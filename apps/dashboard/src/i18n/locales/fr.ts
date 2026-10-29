import type en from './en'
import ui from './fr/index'

// Messages en français : mêmes clés que en.ts (un test le vérifie).
export default {
  common: {
    cancel: 'Annuler',
    close: 'Fermer',
    retry: 'Réessayer',
    save: 'Enregistrer',
    loading: 'Chargement…',
    section: 'Section',
    sections: 'Sections',
  },
  apps: {
    files: 'Fichiers',
    apps: 'Applications',
    settings: 'Réglages',
    storage: 'Stockage',
    store: 'App Store',
    monitor: 'Supervision',
    sharing: 'Partage',
    filePreview: 'Aperçu',
  },
  settings: {
    groups: { account: 'Compte', access: 'Accès', system: 'Système', backup: 'Sauvegardes' },
    nav: {
      profile: 'Mon profil',
      shares: 'Liens partagés',
      users: 'Utilisateurs',
      places: 'Emplacements',
      permissions: 'Permissions',
      groups: 'Groupes',
      alerting: 'Seuils d’alerte',
      notifications: 'Notifications',
      secure: 'Accès sécurisé',
      network: 'Réseau',
      updates: 'Mises à jour',
      telemetry: 'Télémétrie',
      backups: 'Sauvegarde et restauration',
      dataBackups: 'Sauvegardes des données',
    },
  },
  storage: {
    nav: { volumes: 'Volumes', disks: 'Disques', raid: 'Grappes RAID', lvm: 'Groupes de volumes', mounts: 'Montages', maintenance: 'Maintenance' },
    createVolume: 'Créer un volume',
  },
  monitor: {
    nav: { overview: 'Résumé', systemInfo: 'Système', monitoring: 'Suivi', alerts: 'Alertes', audit: 'Journal d’audit' },
  },
  sharing: {
    nav: { shares: 'Partages', connections: 'Connexions', diagnostics: 'Diagnostic' },
  },
  account: {
    administrator: 'Administrateur',
    user: 'Utilisateur',
    profile: 'Profil',
    desktopMode: 'Mode bureau',
    resetSidebar: 'Réinitialiser l’ordre de la barre latérale',
    signOut: 'Se déconnecter',
  },
  login: {
    username: 'Nom d’utilisateur',
    usernamePlaceholder: 'Votre nom d’utilisateur',
    password: 'Mot de passe',
    showPassword: 'Afficher le mot de passe',
    hidePassword: 'Masquer le mot de passe',
    signIn: 'Se connecter',
    signingIn: 'Connexion…',
    invalid: 'Nom d’utilisateur ou mot de passe incorrect',
  },
  ui,
  profile: {
    language: 'Langue',
    languageHint: 'La langue de l’interface sur tous les appareils où vous vous connectez.',
  },
} satisfies typeof en
