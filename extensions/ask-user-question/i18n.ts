import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Locale = "en" | "es" | "fr" | "pt-BR";
type Params = Record<string, string | number>;

const translations: Record<Exclude<Locale, "en">, Record<string, string>> = {
	es: {
		"ask.pressEnterSubmit": "Pulsa Enter para enviar",
		"ask.required": "Obligatorio: {missing}",
		"ask.navQuestions": "Tab/←→ navegar preguntas • Enter enviar • Esc cancelar",
		"ask.type.single": "[selección única]",
		"ask.type.multi": "[selección múltiple]",
		"ask.type.text": "[texto]",
		"ask.requiredMark": "*obligatorio",
		"ask.other": "Otro...",
		"ask.otherValue": "Otro: {value}",
		"ask.yourAnswer": "Tu respuesta:",
		"ask.enterBack": "Enter enviar • Esc volver",
		"ask.textFooter": "{nav}Enter enviar • Esc cancelar",
		"ask.checkboxFooter": "↑↓ navegar • Space alternar • {nav}Enter {action} • Esc cancelar",
		"ask.radioFooter": "↑↓ navegar • {nav}Enter seleccionar • Esc cancelar",
		"ask.next": "siguiente",
		"ask.submit": "enviar",
		"ask.cancelled": "El usuario canceló el formulario",
	},
	fr: {
		"ask.pressEnterSubmit": "Appuyez sur Entrée pour envoyer",
		"ask.required": "Obligatoire : {missing}",
		"ask.navQuestions": "Tab/←→ parcourir les questions • Entrée envoyer • Échap annuler",
		"ask.type.single": "[sélection unique]",
		"ask.type.multi": "[sélection multiple]",
		"ask.type.text": "[texte]",
		"ask.requiredMark": "*obligatoire",
		"ask.other": "Autre...",
		"ask.otherValue": "Autre : {value}",
		"ask.yourAnswer": "Votre réponse :",
		"ask.enterBack": "Entrée envoyer • Échap revenir",
		"ask.textFooter": "{nav}Entrée envoyer • Échap annuler",
		"ask.checkboxFooter": "↑↓ naviguer • Espace basculer • {nav}Entrée {action} • Échap annuler",
		"ask.radioFooter": "↑↓ naviguer • {nav}Entrée sélectionner • Échap annuler",
		"ask.next": "suivant",
		"ask.submit": "envoyer",
		"ask.cancelled": "L’utilisateur a annulé le formulaire",
	},
	"pt-BR": {
		"ask.pressEnterSubmit": "Pressione Enter para enviar",
		"ask.required": "Obrigatório: {missing}",
		"ask.navQuestions": "Tab/←→ navegar perguntas • Enter enviar • Esc cancelar",
		"ask.type.single": "[seleção única]",
		"ask.type.multi": "[seleção múltipla]",
		"ask.type.text": "[texto]",
		"ask.requiredMark": "*obrigatório",
		"ask.other": "Outro...",
		"ask.otherValue": "Outro: {value}",
		"ask.yourAnswer": "Sua resposta:",
		"ask.enterBack": "Enter enviar • Esc voltar",
		"ask.textFooter": "{nav}Enter enviar • Esc cancelar",
		"ask.checkboxFooter": "↑↓ navegar • Space alternar • {nav}Enter {action} • Esc cancelar",
		"ask.radioFooter": "↑↓ navegar • {nav}Enter selecionar • Esc cancelar",
		"ask.next": "próxima",
		"ask.submit": "enviar",
		"ask.cancelled": "O usuário cancelou o formulário",
	},
};

let currentLocale: Locale = "en";

export function initI18n(pi: ExtensionAPI): void {
	pi.events?.emit?.("pi-core/i18n/registerBundle", {
		namespace: "pi-mono-ask-user-question",
		defaultLocale: "en",
		locales: translations,
	});

	pi.events?.emit?.("pi-core/i18n/requestApi", {
		onReady: (api: { getLocale?: () => string; onLocaleChange?: (cb: (locale: string) => void) => void }) => {
			const next = api.getLocale?.();
			if (isLocale(next)) currentLocale = next;
			api.onLocaleChange?.((locale) => {
				if (isLocale(locale)) currentLocale = locale;
			});
		},
	});
}

export function t(key: string, fallback: string, params: Params = {}): string {
	const template = currentLocale === "en" ? fallback : translations[currentLocale]?.[key] ?? fallback;
	return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}

function isLocale(locale: string | undefined): locale is Locale {
	return locale === "en" || locale === "es" || locale === "fr" || locale === "pt-BR";
}
