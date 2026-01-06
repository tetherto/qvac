"""Dataset loading for TTS benchmarks"""

import logging
from typing import List

from datasets import load_dataset
from .config import DatasetConfig

logger = logging.getLogger(__name__)

# Harvard Sentences - Phonetically Balanced Sentences for Speech Testing
# IEEE Recommended Practice for Speech Quality Measurements

# English (en-us)
HARVARD_SENTENCES_EN = [
    # List 1
    "The birch canoe slid on the smooth planks.",
    "Glue the sheet to the dark blue background.",
    "It's easy to tell the depth of a well.",
    "These days a chicken leg is a rare dish.",
    "Rice is often served in round bowls.",
    "The juice of lemons makes fine punch.",
    "The box was thrown beside the parked truck.",
    "The hogs were fed chopped corn and garbage.",
    "Four hours of steady work faced us.",
    "A large size in stockings is hard to sell.",
    
    # List 2
    "The boy was there when the sun rose.",
    "A rod is used to catch pink salmon.",
    "The source of the huge river is the clear spring.",
    "Kick the ball straight and follow through.",
    "Help the woman get back to her feet.",
    "A pot of tea helps to pass the evening.",
    "Smoky fires lack flame and heat.",
    "The soft cushion broke the man's fall.",
    "The salt breeze came across from the sea.",
    "The girl at the booth sold fifty bonds.",
    
    # List 3
    "The small pup gnawed a hole in the sock.",
    "The fish twisted and turned on the bent hook.",
    "Press the pants and sew a button on the vest.",
    "The swan dive was far short of perfect.",
    "The beauty of the view stunned the young boy.",
    "Two blue fish swam in the tank.",
    "Her purse was full of useless trash.",
    "The colt reared and threw the tall rider.",
    "It snowed, rained, and hailed the same morning.",
    "Read verse out loud for pleasure.",
    
    # List 4
    "Hoist the load to your left shoulder.",
    "Take the winding path to reach the lake.",
    "Note closely the size of the gas tank.",
    "Wipe the grease off his dirty face.",
    "Mend the coat before you go out.",
    "The wrist was badly strained and hung limp.",
    "The stray cat gave birth to kittens.",
    "The young girl gave no clear response.",
    "The meal was cooked before the bell rang.",
    "What joy there is in living.",
    
    # List 5
    "A king ruled the state in the early days.",
    "The ship was torn apart on the sharp reef.",
    "Sickness kept him home the third week.",
    "The wide road shimmered in the hot sun.",
    "The lazy cow lay in the cool grass.",
    "Lift the square stone over the fence.",
    "The rope will bind the seven books at once.",
    "Hop over the fence and plunge in.",
    "The friendly gang left the drug store.",
    "Mesh wire keeps chicks inside.",
    
    # List 6
    "The frosty air passed through the coat.",
    "The crooked maze failed to fool the mouse.",
    "Adding fast leads to wrong sums.",
    "The show was a flop from the very start.",
    "A saw is a tool used for making boards.",
    "The wagon moved on well oiled wheels.",
    "March the soldiers past the next hill.",
    "A cup of sugar makes sweet fudge.",
    "Place a rosebush near the porch steps.",
    "Both lost their lives in the raging storm.",
    
    # List 7
    "We talked of the side show in the circus.",
    "Use a pencil to write the first draft.",
    "He ran half way to the hardware store.",
    "The clock struck to mark the third period.",
    "A small creek cut across the field.",
    "Cars and busses stalled in snow drifts.",
    "The set of china hit the floor with a crash.",
    "This is a grand season for hikes on the road.",
    "The dune rose from the edge of the water.",
    "Those words were the cue for the actor to leave.",
]

# Spanish (es)
HARVARD_SENTENCES_ES = [
    # Lista 1
    "La canoa de abedul se deslizó sobre las tablas lisas.",
    "Pega la hoja al fondo azul oscuro.",
    "Es fácil determinar la profundidad de un pozo.",
    "Hoy en día una pierna de pollo es un plato raro.",
    "El arroz se sirve a menudo en cuencos redondos.",
    "El jugo de limones hace un ponche excelente.",
    "La caja fue arrojada junto al camión estacionado.",
    "Los cerdos fueron alimentados con maíz picado y basura.",
    "Cuatro horas de trabajo constante nos esperaban.",
    "Una talla grande en medias es difícil de vender.",
    
    # Lista 2
    "El niño estaba allí cuando salió el sol.",
    "Se usa una caña para pescar salmón rosado.",
    "La fuente del enorme río es el manantial claro.",
    "Patea la pelota derecho y sigue el movimiento.",
    "Ayuda a la mujer a ponerse de pie.",
    "Una taza de té ayuda a pasar la tarde.",
    "Los fuegos humeantes carecen de llama y calor.",
    "El cojín suave amortiguó la caída del hombre.",
    "La brisa salada vino desde el mar.",
    "La chica del puesto vendió cincuenta bonos.",
    
    # Lista 3
    "El cachorro pequeño mordisqueó un agujero en el calcetín.",
    "El pez se retorció y giró en el anzuelo doblado.",
    "Plancha los pantalones y cose un botón en el chaleco.",
    "El salto del cisne estuvo lejos de ser perfecto.",
    "La belleza de la vista dejó atónito al joven.",
    "Dos peces azules nadaron en el tanque.",
    "Su bolso estaba lleno de basura inútil.",
    "El potro se encabritó y tiró al jinete alto.",
    "Nevó, llovió y granizó la misma mañana.",
    "Lee versos en voz alta por placer.",
    
    # Lista 4
    "Levanta la carga sobre tu hombro izquierdo.",
    "Toma el camino sinuoso para llegar al lago.",
    "Observa atentamente el tamaño del tanque de gasolina.",
    "Limpia la grasa de su cara sucia.",
    "Arregla el abrigo antes de salir.",
    "La muñeca estaba muy torcida y colgaba floja.",
    "El gato callejero dio a luz gatitos.",
    "La joven no dio una respuesta clara.",
    "La comida se cocinó antes de que sonara la campana.",
    "Qué alegría hay en vivir.",
    
    # Lista 5
    "Un rey gobernó el estado en los primeros días.",
    "El barco fue destrozado en el arrecife afilado.",
    "La enfermedad lo mantuvo en casa la tercera semana.",
    "El camino ancho brillaba bajo el sol ardiente.",
    "La vaca perezosa yacía en la hierba fresca.",
    "Levanta la piedra cuadrada sobre la valla.",
    "La cuerda atará los siete libros de una vez.",
    "Salta la valla y sumérgete.",
    "La pandilla amigable salió de la farmacia.",
    "La malla de alambre mantiene a los pollitos adentro.",
    
    # Lista 6
    "El aire helado atravesó el abrigo.",
    "El laberinto torcido no logró engañar al ratón.",
    "Sumar rápido conduce a sumas incorrectas.",
    "El espectáculo fue un fracaso desde el principio.",
    "Una sierra es una herramienta usada para hacer tablas.",
    "El vagón se movió sobre ruedas bien engrasadas.",
    "Marcha a los soldados más allá de la próxima colina.",
    "Una taza de azúcar hace dulce de azúcar.",
    "Coloca un rosal cerca de los escalones del porche.",
    "Ambos perdieron sus vidas en la tormenta furiosa.",
    
    # Lista 7
    "Hablamos del espectáculo secundario en el circo.",
    "Usa un lápiz para escribir el primer borrador.",
    "Corrió hasta la mitad del camino a la ferretería.",
    "El reloj sonó para marcar el tercer período.",
    "Un pequeño arroyo cruzaba el campo.",
    "Autos y autobuses se atascaron en ventisqueros.",
    "El juego de porcelana golpeó el suelo con estruendo.",
    "Esta es una gran temporada para caminatas en el camino.",
    "La duna se elevó desde el borde del agua.",
    "Esas palabras fueron la señal para que el actor se fuera.",
]

# German (de)
HARVARD_SENTENCES_DE = [
    # Liste 1
    "Das Birkenkanu glitt über die glatten Bretter.",
    "Klebe das Blatt auf den dunkelblauen Hintergrund.",
    "Es ist leicht, die Tiefe eines Brunnens zu bestimmen.",
    "Heutzutage ist ein Hühnerbein ein seltenes Gericht.",
    "Reis wird oft in runden Schalen serviert.",
    "Der Saft von Zitronen ergibt einen feinen Punsch.",
    "Die Kiste wurde neben den geparkten Lastwagen geworfen.",
    "Die Schweine wurden mit gehacktem Mais und Abfall gefüttert.",
    "Vier Stunden ständiger Arbeit erwarteten uns.",
    "Eine große Größe bei Strümpfen ist schwer zu verkaufen.",
    
    # Liste 2
    "Der Junge war dort, als die Sonne aufging.",
    "Eine Rute wird verwendet, um rosa Lachs zu fangen.",
    "Die Quelle des riesigen Flusses ist die klare Quelle.",
    "Tritt den Ball gerade und folge durch.",
    "Hilf der Frau wieder auf die Beine.",
    "Eine Kanne Tee hilft, den Abend zu verbringen.",
    "Rauchige Feuer fehlen Flamme und Hitze.",
    "Das weiche Kissen brach den Fall des Mannes.",
    "Die salzige Brise kam vom Meer herüber.",
    "Das Mädchen am Stand verkaufte fünfzig Anleihen.",
    
    # Liste 3
    "Der kleine Welpe nagte ein Loch in die Socke.",
    "Der Fisch drehte und wendete sich am gebogenen Haken.",
    "Bügle die Hose und näh einen Knopf an die Weste.",
    "Der Schwanentaucher war weit von perfekt entfernt.",
    "Die Schönheit der Aussicht verblüffte den jungen Jungen.",
    "Zwei blaue Fische schwammen im Tank.",
    "Ihre Handtasche war voll nutzlosem Müll.",
    "Das Fohlen bäumte sich auf und warf den großen Reiter ab.",
    "Es schneite, regnete und hagelte am selben Morgen.",
    "Lies Verse laut zum Vergnügen vor.",
    
    # Liste 4
    "Hebe die Last auf deine linke Schulter.",
    "Nimm den gewundenen Pfad, um den See zu erreichen.",
    "Beachte genau die Größe des Benzintanks.",
    "Wische das Fett von seinem schmutzigen Gesicht.",
    "Repariere den Mantel, bevor du hinausgehst.",
    "Das Handgelenk war stark verstaucht und hing schlaff.",
    "Die streunende Katze brachte Kätzchen zur Welt.",
    "Das junge Mädchen gab keine klare Antwort.",
    "Das Essen wurde gekocht, bevor die Glocke läutete.",
    "Welche Freude es im Leben gibt.",
    
    # Liste 5
    "Ein König regierte den Staat in den frühen Tagen.",
    "Das Schiff wurde am scharfen Riff zerrissen.",
    "Krankheit hielt ihn die dritte Woche zu Hause.",
    "Die breite Straße schimmerte in der heißen Sonne.",
    "Die faule Kuh lag im kühlen Gras.",
    "Hebe den quadratischen Stein über den Zaun.",
    "Das Seil wird die sieben Bücher auf einmal binden.",
    "Springe über den Zaun und tauche ein.",
    "Die freundliche Bande verließ die Drogerie.",
    "Maschendraht hält Küken drinnen.",
    
    # Liste 6
    "Die frostige Luft drang durch den Mantel.",
    "Das krumme Labyrinth konnte die Maus nicht täuschen.",
    "Schnelles Addieren führt zu falschen Summen.",
    "Die Show war von Anfang an ein Flop.",
    "Eine Säge ist ein Werkzeug zum Herstellen von Brettern.",
    "Der Wagen bewegte sich auf gut geölten Rädern.",
    "Marschiere die Soldaten am nächsten Hügel vorbei.",
    "Eine Tasse Zucker macht süßen Fudge.",
    "Stelle einen Rosenbusch in die Nähe der Verandas tufen.",
    "Beide verloren ihr Leben im tobenden Sturm.",
    
    # Liste 7
    "Wir sprachen über die Nebenshow im Zirkus.",
    "Benutze einen Bleistift, um den ersten Entwurf zu schreiben.",
    "Er rannte halb zum Eisenwarenladen.",
    "Die Uhr schlug, um die dritte Periode zu markieren.",
    "Ein kleiner Bach durchquerte das Feld.",
    "Autos und Busse steckten in Schneewehen fest.",
    "Das Porzellanset traf mit einem Krachen auf den Boden.",
    "Dies ist eine großartige Saison für Wanderungen auf der Straße.",
    "Die Düne erhob sich vom Rand des Wassers.",
    "Diese Worte waren das Stichwort für den Schauspieler zu gehen.",
]

# Italian (it)
HARVARD_SENTENCES_IT = [
    # Lista 1
    "La canoa di betulla scivolò sulle tavole lisce.",
    "Incolla il foglio sullo sfondo blu scuro.",
    "È facile determinare la profondità di un pozzo.",
    "Oggi una coscia di pollo è un piatto raro.",
    "Il riso viene spesso servito in ciotole rotonde.",
    "Il succo di limoni fa un ottimo punch.",
    "La scatola fu gettata accanto al camion parcheggiato.",
    "I maiali furono nutriti con mais tritato e spazzatura.",
    "Quattro ore di lavoro costante ci aspettavano.",
    "Una taglia grande di calze è difficile da vendere.",
    
    # Lista 2
    "Il ragazzo era lì quando sorse il sole.",
    "Una canna è usata per pescare il salmone rosa.",
    "La sorgente dell'enorme fiume è la chiara sorgente.",
    "Calcia la palla dritta e segui il movimento.",
    "Aiuta la donna a rimettersi in piedi.",
    "Una tazza di tè aiuta a passare la sera.",
    "I fuochi fumosi mancano di fiamma e calore.",
    "Il morbido cuscino attutì la caduta dell'uomo.",
    "La brezza salata arrivò dal mare.",
    "La ragazza allo stand vendette cinquanta obbligazioni.",
    
    # Lista 3
    "Il piccolo cucciolo rosicchiò un buco nel calzino.",
    "Il pesce si contorse e girò sull'amo piegato.",
    "Stira i pantaloni e cuci un bottone sul gilet.",
    "Il tuffo del cigno era lontano dall'essere perfetto.",
    "La bellezza della vista stupì il giovane ragazzo.",
    "Due pesci blu nuotarono nella vasca.",
    "La sua borsa era piena di spazzatura inutile.",
    "Il puledro si impennò e gettò l'alto cavaliere.",
    "Nevicò, piovve e grandinò la stessa mattina.",
    "Leggi versi ad alta voce per piacere.",
    
    # Lista 4
    "Solleva il carico sulla tua spalla sinistra.",
    "Prendi il sentiero tortuoso per raggiungere il lago.",
    "Nota attentamente la dimensione del serbatoio della benzina.",
    "Pulisci il grasso dalla sua faccia sporca.",
    "Ripara il cappotto prima di uscire.",
    "Il polso era gravemente distorto e pendeva floscio.",
    "Il gatto randagio partorì dei gattini.",
    "La giovane ragazza non diede una risposta chiara.",
    "Il pasto fu cucinato prima che suonasse la campana.",
    "Che gioia c'è nel vivere.",
    
    # Lista 5
    "Un re governò lo stato nei primi giorni.",
    "La nave fu fatta a pezzi sulla scogliera affilata.",
    "La malattia lo tenne a casa la terza settimana.",
    "La strada larga luccicava sotto il sole caldo.",
    "La mucca pigra giaceva nell'erba fresca.",
    "Solleva la pietra quadrata oltre il recinto.",
    "La corda legherà i sette libri in una volta.",
    "Salta oltre il recinto e tuffati.",
    "La banda amichevole lasciò la farmacia.",
    "La rete metallica tiene i pulcini dentro.",
    
    # Lista 6
    "L'aria gelida attraversò il cappotto.",
    "Il labirinto storto non riuscì a ingannare il topo.",
    "Sommare velocemente porta a somme sbagliate.",
    "Lo spettacolo fu un fiasco fin dall'inizio.",
    "Una sega è uno strumento usato per fare assi.",
    "Il carro si muoveva su ruote ben oliate.",
    "Marcia i soldati oltre la prossima collina.",
    "Una tazza di zucchero fa un dolce fondente.",
    "Metti un cespuglio di rose vicino ai gradini del portico.",
    "Entrambi persero la vita nella tempesta furiosa.",
    
    # Lista 7
    "Parlammo dello spettacolo secondario al circo.",
    "Usa una matita per scrivere la prima bozza.",
    "Corse a metà strada verso il negozio di ferramenta.",
    "L'orologio suonò per segnare il terzo periodo.",
    "Un piccolo ruscello attraversava il campo.",
    "Auto e autobus si bloccarono nei cumuli di neve.",
    "Il servizio di porcellana colpì il pavimento con fracasso.",
    "Questa è una grande stagione per escursioni sulla strada.",
    "La duna si alzò dal bordo dell'acqua.",
    "Quelle parole furono il segnale per l'attore di andarsene.",
]

# French (fr)
HARVARD_SENTENCES_FR = [
    # Liste 1
    "Le canoë de bouleau glissa sur les planches lisses.",
    "Colle la feuille sur le fond bleu foncé.",
    "Il est facile de mesurer la profondeur d'un puits.",
    "De nos jours, une cuisse de poulet est un plat rare.",
    "Le riz est souvent servi dans des bols ronds.",
    "Le jus de citrons fait un excellent punch.",
    "La boîte fut jetée à côté du camion garé.",
    "Les cochons furent nourris avec du maïs haché et des déchets.",
    "Quatre heures de travail assidu nous attendaient.",
    "Une grande taille en bas est difficile à vendre.",
    
    # Liste 2
    "Le garçon était là quand le soleil se leva.",
    "Une canne sert à attraper le saumon rose.",
    "La source de l'énorme rivière est la source claire.",
    "Frappe le ballon droit et suis le mouvement.",
    "Aide la femme à se remettre sur pied.",
    "Une tasse de thé aide à passer la soirée.",
    "Les feux fumants manquent de flamme et de chaleur.",
    "Le coussin moelleux amortit la chute de l'homme.",
    "La brise salée venait de la mer.",
    "La fille au stand vendit cinquante obligations.",
    
    # Liste 3
    "Le petit chiot rongea un trou dans la chaussette.",
    "Le poisson se tordit et tourna sur l'hameçon plié.",
    "Repasse le pantalon et couds un bouton sur le gilet.",
    "Le plongeon du cygne était loin d'être parfait.",
    "La beauté de la vue stupéfia le jeune garçon.",
    "Deux poissons bleus nagèrent dans le réservoir.",
    "Son sac était plein de déchets inutiles.",
    "Le poulain se cabra et jeta le grand cavalier.",
    "Il neigea, plut et grêla le même matin.",
    "Lis des vers à haute voix pour le plaisir.",
    
    # Liste 4
    "Hisse la charge sur ton épaule gauche.",
    "Prends le chemin sinueux pour atteindre le lac.",
    "Note attentivement la taille du réservoir d'essence.",
    "Essuie la graisse de son visage sale.",
    "Répare le manteau avant de sortir.",
    "Le poignet était gravement foulé et pendait mollement.",
    "Le chat errant donna naissance à des chatons.",
    "La jeune fille ne donna aucune réponse claire.",
    "Le repas fut cuisiné avant que la cloche sonne.",
    "Quelle joie il y a à vivre.",
    
    # Liste 5
    "Un roi gouverna l'état dans les premiers jours.",
    "Le navire fut déchiré sur le récif acéré.",
    "La maladie le garda chez lui la troisième semaine.",
    "La large route miroitait sous le soleil brûlant.",
    "La vache paresseuse gisait dans l'herbe fraîche.",
    "Soulève la pierre carrée par-dessus la clôture.",
    "La corde attachera les sept livres en une fois.",
    "Saute par-dessus la clôture et plonge.",
    "La bande amicale quitta la pharmacie.",
    "Le grillage garde les poussins à l'intérieur.",
    
    # Liste 6
    "L'air glacial traversa le manteau.",
    "Le labyrinthe tordu ne parvint pas à tromper la souris.",
    "Additionner vite mène à de fausses sommes.",
    "Le spectacle fut un échec dès le début.",
    "Une scie est un outil utilisé pour faire des planches.",
    "Le chariot avançait sur des roues bien huilées.",
    "Fais marcher les soldats au-delà de la prochaine colline.",
    "Une tasse de sucre fait un bon fondant.",
    "Place un rosier près des marches du porche.",
    "Tous deux perdirent la vie dans la tempête déchaînée.",
    
    # Liste 7
    "Nous avons parlé du spectacle secondaire au cirque.",
    "Utilise un crayon pour écrire le premier brouillon.",
    "Il courut à mi-chemin de la quincaillerie.",
    "L'horloge sonna pour marquer la troisième période.",
    "Un petit ruisseau traversait le champ.",
    "Les voitures et les bus se bloquèrent dans les congères.",
    "Le service de porcelaine heurta le sol avec fracas.",
    "C'est une grande saison pour les randonnées sur la route.",
    "La dune s'éleva du bord de l'eau.",
    "Ces mots furent le signal pour l'acteur de partir.",
]

# Language mapping
HARVARD_SENTENCES_BY_LANGUAGE = {
    "en": HARVARD_SENTENCES_EN,
    "en-us": HARVARD_SENTENCES_EN,
    "es": HARVARD_SENTENCES_ES,
    "es-es": HARVARD_SENTENCES_ES,
    "de": HARVARD_SENTENCES_DE,
    "de-de": HARVARD_SENTENCES_DE,
    "it": HARVARD_SENTENCES_IT,
    "it-it": HARVARD_SENTENCES_IT,
    "fr": HARVARD_SENTENCES_FR,
    "fr-fr": HARVARD_SENTENCES_FR,
}


def load_harvard_sentences(cfg: DatasetConfig, language: str = "en-us") -> List[str]:
    """
    Load Harvard Sentences for benchmarking in the specified language.
    These are 72 phonetically balanced sentences designed for speech testing.
    
    Args:
        cfg: Dataset configuration
        language: Language code (e.g., 'en-us', 'es', 'de', 'it')
        
    Returns:
        List of text strings to synthesize
    """
    # Normalize language code to lowercase
    language = language.lower()
    
    # Get sentences for the specified language, fallback to English if not found
    if language in HARVARD_SENTENCES_BY_LANGUAGE:
        texts = HARVARD_SENTENCES_BY_LANGUAGE[language].copy()
        logger.info(f"Loading Harvard Sentences (phonetically balanced) for language: {language}")
    else:
        # Try to extract base language code (e.g., 'en' from 'en-us')
        base_language = language.split('-')[0]
        if base_language in HARVARD_SENTENCES_BY_LANGUAGE:
            texts = HARVARD_SENTENCES_BY_LANGUAGE[base_language].copy()
            logger.info(f"Loading Harvard Sentences for base language: {base_language}")
        else:
            texts = HARVARD_SENTENCES_EN.copy()
            logger.warning(f"Language '{language}' not found, falling back to English. Supported languages: {', '.join(HARVARD_SENTENCES_BY_LANGUAGE.keys())}")
    
    logger.info(f"Loaded {len(texts)} Harvard sentences")
    
    # Limit samples if configured
    if cfg.max_samples > 0 and cfg.max_samples < len(texts):
        texts = texts[:cfg.max_samples]
        logger.info(f"Limited to {len(texts)} samples based on max_samples config")
    
    return texts


def load_ag_news(cfg: DatasetConfig) -> List[str]:
    """
    Load text samples from AG News dataset
    
    Args:
        cfg: Dataset configuration
        
    Returns:
        List of text strings to synthesize
    """
    logger.info(f"Loading benchmark texts from AG News dataset")
    
    # Load AG News test split (7,600 news articles)
    ds = load_dataset("ag_news", split="test")
    benchmark_texts = ds["text"]
    
    logger.info(f"Loaded {len(benchmark_texts)} benchmark texts")
    
    # Limit samples if configured
    if cfg.max_samples > 0 and cfg.max_samples < len(benchmark_texts):
        texts = benchmark_texts[:cfg.max_samples]
        logger.info(f"Limited to {len(texts)} samples based on max_samples config")
        return texts
    
    return benchmark_texts


def load_librispeech(cfg: DatasetConfig) -> List[str]:
    """
    Load text samples from LibriSpeech test-clean
    
    Args:
        cfg: Dataset configuration
        
    Returns:
        List of text strings to synthesize
    """
    logger.info(f"Loading benchmark texts from LibriSpeech test-clean")
    
    # Load LibriSpeech test-clean split
    ds = load_dataset("librispeech_asr", split="test.clean")
    benchmark_texts = ds["text"]
    
    logger.info(f"Loaded {len(benchmark_texts)} benchmark texts")
    
    # Limit samples if configured
    if cfg.max_samples > 0 and cfg.max_samples < len(benchmark_texts):
        texts = benchmark_texts[:cfg.max_samples]
        logger.info(f"Limited to {len(texts)} samples based on max_samples config")
        return texts
    
    return benchmark_texts


def load_dataset_texts(cfg: DatasetConfig, language: str = "en-us") -> List[str]:
    """
    Load dataset texts based on configuration
    
    Args:
        cfg: Dataset configuration
        language: Language code for multilingual datasets (e.g., 'en-us', 'es', 'de', 'it')
        
    Returns:
        List of text strings
    """
    dataset_name = cfg.name.lower()
    
    # For Harvard sentences, pass language parameter
    if dataset_name == "harvard":
        return load_harvard_sentences(cfg, language)
    
    # For other datasets, use the original loaders (no language support yet)
    dataset_loaders = {
        "ag_news": load_ag_news,
        "librispeech": load_librispeech,
    }
    
    if dataset_name not in dataset_loaders:
        logger.warning(f"Unknown dataset '{cfg.name}', falling back to Harvard sentences")
        return load_harvard_sentences(cfg, language)
    
    return dataset_loaders[dataset_name](cfg)


if __name__ == "__main__":
    # Test dataset loading
    from .config import Config
    
    cfg = Config.from_yaml()
    texts = load_dataset_texts(cfg.dataset)
    
    print(f"Loaded {len(texts)} texts")
    print("\nFirst 3 texts:")
    for i, text in enumerate(texts[:3], 1):
        print(f"{i}. {text}")

