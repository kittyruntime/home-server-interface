import type en from './en'
import ui from './fr/index'
import uip from './fr/params/index'
import uis from './fr/script/index'
import lib from './fr/lib'

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
  uip,
  uis,
  lib,
  profile: {
    language: 'Langue',
    languageHint: 'La langue de l’interface sur tous les appareils où vous vous connectez.',
    confirmFileDelete: 'Confirmer avant de supprimer',
    confirmFileDeleteHint: 'Demander avant de supprimer des fichiers et dossiers dans le gestionnaire de fichiers. La suppression est définitive.',
  },
  fileDelete: {
    title: 'Supprimer définitivement ?',
    confirm: 'Supprimer',
    messageFile: '« {name} » sera supprimé. Cette action est irréversible.',
    messageFolder: 'Le dossier « {name} » et tout son contenu seront supprimés. Cette action est irréversible.',
    messageMany: '{count} éléments seront supprimés, les dossiers avec tout leur contenu. Cette action est irréversible.',
    dontAskAgain: 'Ne plus demander',
    deleting: 'Suppression de {count} élément(s)',
  },
  maintenance: {
    titleUpdate: 'Mise à jour de HSI',
    titleUpdateTo: 'Mise à jour de HSI vers {version}',
    titleRestart: 'Redémarrage de HSI',
    titleReboot: 'Redémarrage du serveur',
    hint: 'N’éteignez pas le serveur. Les modifications sont suspendues sur tous les appareils jusqu’à son retour, puis cette page se recharge.',
    step: {
      scheduled: 'Demandé',
      working: 'En cours',
      offline: 'En attente du retour du serveur',
      done: 'De nouveau en ligne',
    },
    stepInstalling: 'Téléchargement et installation',
    stepRestarting: 'Redémarrage',
    stepRebooting: 'Redémarrage',
    reloadingIn: 'Rechargement dans {seconds}…',
    reload: 'Recharger la page',
  },
} satisfies typeof en
