/** Synthetic notes and hand-reviewed example plans. These exercise the
 * editorial tradeoffs; they are not recorded outputs from a hosted model. */
import type { AiDiagramPlan, AiMindMapPlan } from '@/lib/schema';

export const MEMORY_NOTE = {
  title: 'Apprendre durablement',
  markdown: `# Apprendre durablement
La mémoire de travail est limitée. Regrouper des éléments en unités significatives réduit la charge.
La relecture donne une impression de familiarité, qui ne prouve pas qu'on saura restituer.
Se tester sans regarder sollicite la récupération. Le retour correctif évite de répéter une erreur.
Espacer les révisions oblige à récupérer après un délai; allonger progressivement le délai.
Alterner des problèmes différents aide à choisir la méthode, plutôt que reproduire le dernier exemple.
Expliquer une idée avec ses propres mots et la relier à un acquis aide à lui donner du sens.
Le sommeil contribue à la consolidation. Une nuit blanche ne remplace pas plusieurs séances.
Exemples: cartes, quiz, récitation, questions ouvertes, exercices corrigés, schémas, analogies, fiches.
Organisation: calendrier, code couleur, applications, classeurs, stylos, bibliothèque, groupe de travail.
Pour mardi: apporter le manuel. Examen le 15 juin. Lecture complémentaire: chapitre 8.
Un étudiant préfère les cartes; une autre préfère les questions ouvertes.`,
  language: 'fr',
};

export const MEMORY_PLAN: AiMindMapPlan = {
  title: 'Apprendre pour restituer',
  focus: 'Comment passer de la familiarité à une restitution durable ?',
  takeaway:
    'Organiser le sens, récupérer activement et répartir les séances aide à apprendre durablement.',
  rationale:
    'Trois leviers de révision structurent la carte; les formats de travail restent des exemples plutôt que des branches.',
  omitted: [
    'Catalogue des outils : les formats ne sont pas les mécanismes.',
    'Logistique et échéances : hors de l’objectif de révision.',
    'Préférences individuelles : anecdotes redondantes.',
  ],
  root: 'Restitution durable',
  branches: [
    {
      label: 'Construire le sens',
      note: 'Tenir compte de la mémoire de travail limitée.',
      children: [{ label: 'Regrouper en unités' }, { label: 'Expliquer et relier' }],
    },
    {
      label: 'Récupérer activement',
      children: [
        { label: 'Tester sans regarder' },
        { label: 'Corriger les erreurs' },
        { label: 'Distinguer familiarité et maîtrise' },
      ],
    },
    {
      label: 'Répartir la pratique',
      children: [
        { label: 'Espacer progressivement' },
        { label: 'Alterner les problèmes' },
        {
          label: 'Préserver le sommeil',
          note: 'Le sommeil contribue à la consolidation.',
        },
      ],
    },
  ],
};

export const THERMOSTAT_NOTE = {
  title: 'Régulation du chauffage',
  markdown: `Le capteur mesure la température de la pièce. Le régulateur compare cette mesure à la consigne.
Sous la consigne, il active le chauffage. À la consigne ou au-dessus, il coupe le chauffage.
Le chauffage actif augmente la température de la pièce. Une pièce plus chaude augmente la mesure du capteur.
Les pertes thermiques refroidissent la pièce. La mesure et la consigne sont deux entrées distinctes de la comparaison.
La boucle ramène la mesure à la comparaison: elle ne s'arrête pas après une seule décision.
L'histoire du thermostat et le choix du boîtier ne font pas partie du mécanisme étudié.`,
  language: 'fr',
};

export const THERMOSTAT_PLAN: AiDiagramPlan = {
  title: 'La boucle du thermostat',
  focus: 'Comment la mesure règle-t-elle le chauffage en boucle ?',
  takeaway:
    'La comparaison à la consigne active ou coupe le chauffage, qui modifie la température mesurée.',
  rationale:
    'La décision garde ses deux entrées, ses deux issues et le retour de la pièce vers le capteur.',
  omitted: ['Historique et boîtier : sans rôle dans cette boucle.'],
  kind: 'flowchart',
  direction: 'TB',
  nodes: [
    { id: 'sensor', label: 'Mesure du capteur', shape: 'box' },
    { id: 'setpoint', label: 'Consigne de température', shape: 'box' },
    { id: 'compare', label: 'Température sous la consigne ?', shape: 'decision' },
    { id: 'on', label: 'Chauffage actif', shape: 'box' },
    { id: 'off', label: 'Chauffage coupé', shape: 'box' },
    { id: 'room', label: 'Température de la pièce', shape: 'box' },
    { id: 'losses', label: 'Pertes thermiques', shape: 'box' },
  ],
  edges: [
    { from: 'sensor', to: 'compare', label: 'température mesurée' },
    { from: 'setpoint', to: 'compare', label: 'valeur de référence' },
    { from: 'compare', to: 'on', label: 'oui : activer' },
    { from: 'compare', to: 'off', label: 'non : couper' },
    { from: 'on', to: 'room', label: 'réchauffe' },
    { from: 'losses', to: 'room', label: 'refroidissent' },
    { from: 'room', to: 'sensor', label: 'est mesurée en continu' },
  ],
};

export const SHORT_NOTE = {
  title: 'A short workflow',
  markdown: 'Submit the form. A reviewer checks it and then sends a decision.',
  language: 'en',
};

export const SHORT_PLAN: AiDiagramPlan = {
  title: 'From submission to decision',
  focus: 'What happens after submitting the form?',
  takeaway: 'A review precedes the decision.',
  rationale: 'The note supports three steps and no additional decision branches.',
  omitted: [],
  kind: 'flowchart',
  direction: 'LR',
  nodes: [
    { id: 'submit', label: 'Submit form', shape: 'box' },
    { id: 'review', label: 'Reviewer checks form', shape: 'box' },
    { id: 'decision', label: 'Send decision', shape: 'box' },
  ],
  edges: [
    { from: 'submit', to: 'review', label: 'then reviewed' },
    { from: 'review', to: 'decision', label: 'then decided' },
  ],
};
