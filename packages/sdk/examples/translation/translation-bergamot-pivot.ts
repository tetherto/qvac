import {BERGAMOT_ES_EN, BERGAMOT_EN_IT, loadModel, translate, unloadModel} from "@qvac/sdk";

/**
 * Example: Pivot Translation with Bergamot
 *
 * Demonstrates translating Spanish to Italian through English as a pivot language.
 * This requires two models:
 * 1. Spanish → English (primary model)
 * 2. English → Italian (pivot model)
 *
 * The API structure follows the standard Bergamot model pattern:
 * - modelSrc: Primary translation model
 * - modelConfig: Configuration with Bergamot-specific settings
 * - modelConfig.pivotModel: Configuration for the secondary model
 */

// Spanish to Italian via English pivot example
try {
    // Load the primary model (Spanish → English) with pivot configuration
    const modelId = await loadModel({
        modelSrc: BERGAMOT_ES_EN, // Primary model: Spanish → English
        modelType: "nmt",
        modelConfig: {
            engine: "Bergamot",
            from: "es",
            to: "it", // Final target language (SDK handles the pivot internally)
            beamsize: 4,
            normalize: 1,
            temperature: 0.3,
            topk: 100,
            // Pivot model configuration (English → Italian)
            pivotModel: {
                modelSrc: BERGAMOT_EN_IT, // Source for English → Italian model
                // Bergamot-specific generation parameters for pivot model
                beamsize: 4,
                temperature: 0.3,
                topk: 100,
                normalize: 1,
                lengthpenalty: 1.2,
            }
        },
        onProgress: (progress) => {
            console.log(progress);
        },
    });

    console.log(`✅ Pivot translation model loaded: ${modelId}`);
    console.log("   Primary: Spanish → English");
    console.log("   Pivot: English → Italian");

    // Spanish text to translate
    const spanishText = `Era una mañana soleada cuando María decidió visitar el mercado local.
  Compró frutas frescas, verduras y flores para su casa.
  El vendedor le recomendó las mejores manzanas de la temporada.`;

    console.log("\n📝 Original Spanish text:");
    console.log(spanishText);

    // Translate Spanish → English → Italian
    const result = translate({
        modelId,
        text: spanishText,
        modelType: "nmt",
        stream: false,
    });

    const italianText = await result.text;

    console.log("\n🇮🇹 Translated to Italian (via English):");
    console.log(italianText);

    // Expected output (approximate):
    // "Era una mattina di sole quando Maria decise di visitare il mercato locale.
    //  Ha comprato frutta fresca, verdura e fiori per la sua casa.
    //  Il venditore ha consigliato le migliori mele della stagione."

    await unloadModel({ modelId });
    console.log("\n✅ Model unloaded successfully");

} catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
}
