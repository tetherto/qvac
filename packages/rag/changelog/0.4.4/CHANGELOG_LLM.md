# QVAC RAG v0.4.4 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.4.4

This release focuses on dependency hygiene and package namespace consistency for the RAG library. It aligns documentation with the `@qvac` npm scope and updates core crypto dependency declarations to match current runtime expectations.

---

## 📘 Documentation

README references have been updated from the legacy `@tetherto` namespace to `@qvac`, reducing installation confusion and ensuring examples match currently published package names.

---

## 🧹 Maintenance

`bare-crypto` dependency declarations were updated to `^1.13.4`, and related `package.json` cleanup was applied in the RAG package. This keeps dependency metadata aligned with the current SDK pod ecosystem and reduces drift across package manifests.
