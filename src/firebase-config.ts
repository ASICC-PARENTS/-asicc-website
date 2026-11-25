
const productionFirebaseConfig = {
  apiKey: 'AIzaSyDnVW-BsIgcZ1SxRub5CEKnU99tHFUDbm4',
  authDomain: 'asicc-member-space.firebaseapp.com',
  projectId: 'asicc-member-space',
  storageBucket: 'asicc-member-space.firebasestorage.app',
  messagingSenderId: '1015599431309',
  appId: '1:1015599431309:web:8845b6cbce90ce6ed5acc4',
};

export const firebaseConfig = import.meta.env.PUBLIC_ASICC_BAZAAR_EMULATOR === 'true'
  ? { apiKey: 'demo-asicc-bazaar', authDomain: 'demo-asicc-bazaar.firebaseapp.com', projectId: 'demo-asicc-bazaar' }
  : import.meta.env.PUBLIC_ASICC_BAZAAR_TEST === 'true'
  ? {
      apiKey: import.meta.env.PUBLIC_ASICC_BAZAAR_TEST_API_KEY || 'test-project-api-key-required',
      authDomain: 'asicc-bazaar-test.firebaseapp.com',
      projectId: 'asicc-bazaar-test',
      appId: import.meta.env.PUBLIC_ASICC_BAZAAR_TEST_APP_ID,
    }
  : productionFirebaseConfig;
