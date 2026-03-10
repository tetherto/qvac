// Interactive Gallery Script - Small Version

class PhotoGallery {
    constructor(containerId) {
        this.containerId = containerId;
        this.currentIndex = 0;
        this.images = [
            'sunset.jpg',
            'mountain.jpg', 
            'ocean.jpg',
            'forest.jpg'
        ];
    }
    
    getGalleryHTML() {
        return `
            <div class="gallery-container">
                <img id="current-image" src="${this.images[this.currentIndex]}" alt="Gallery Image">
                <div class="controls">
                    <button id="prev-btn">← Previous</button>
                    <button id="next-btn">Next →</button>
                </div>
            </div>
        `;
    }
    
    nextImage() {
        this.currentIndex = (this.currentIndex + 1) % this.images.length;
        return this.images[this.currentIndex];
    }
    
    prevImage() {
        this.currentIndex = (this.currentIndex - 1 + this.images.length) % this.images.length;
        return this.images[this.currentIndex];
    }
    
    getCurrentImage() {
        return this.images[this.currentIndex];
    }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PhotoGallery;
}
