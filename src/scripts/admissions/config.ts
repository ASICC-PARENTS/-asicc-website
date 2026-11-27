// This separate Worker never connects to the Bazaar API or its database.
export const ADMISSIONS_API = String(import.meta.env.PUBLIC_ASICC_ADMISSIONS_API || 'https://asicc-admissions-registration.falling-hall-f390.workers.dev').replace(/\/$/,'');
export const CITIES = ['Courbevoie','Asnières-sur-Seine','La Garenne-Colombes','Colombes','Puteaux','Gennevilliers','Bois-Colombes','Nanterre','Paris'];
export const GRADES: Record<string,string[]> = {mat:['PS','MS','GS'],elem:['CP','CE1','CE2','CM1','CM2']};
