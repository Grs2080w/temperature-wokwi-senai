export const ROOMS = [
  { id: 'sala1', name: 'Sala 1', color: '#2563eb' },
  { id: 'sala2', name: 'Sala 2', color: '#d97706' },
];

export const VARS = {
  temperature: { label: 'Temperatura', unit: '°C', digits: 1 },
  humidity: { label: 'Umidade', unit: '%', digits: 1 },
};

// Mesmos valores de DEFAULT_LIMITS do flask_app.py
export const DEFAULT_LIMITS = {
  temperature: { min: 18, max: 25 },
  humidity: { min: 30, max: 60 },
};

export const LIVE_WINDOW = 120; // leituras mantidas no grafico ao vivo
export const OFFLINE_AFTER_MS = 90_000; // sem leitura nova => "Sem dados"
